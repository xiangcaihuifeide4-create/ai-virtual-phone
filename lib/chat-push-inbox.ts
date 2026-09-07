// lib/chat-push-inbox.ts
/**
 * 业务收件箱与 drain 机制（对应设计方案 5.3 节和 5.4 节）。
 * 接收来自 AMSG Service Worker 的消息，去重后交给宿主的消息落库逻辑。
 */
import { pushChatMessage } from "./chat-storage";

const INBOX_DB_NAME = "AiPhonePushInbox";
const INBOX_STORE_NAME = "messages";
const RECENT_MESSAGES_LIMIT = 500;

let _recentHandledMessageIds: string[] = [];

// 简易 IndexedDB 封装
function openInboxDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(INBOX_DB_NAME, 1);
        req.onupgradeneeded = (e) => {
            const db = (e.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains(INBOX_STORE_NAME)) {
                db.createObjectStore(INBOX_STORE_NAME, { keyPath: "messageId" });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/** 供 amsg-sw 通过 postMessage 调用的落盘接口 */
export async function saveToInbox(messageId: string, payload: any): Promise<void> {
    const db = await openInboxDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(INBOX_STORE_NAME, "readwrite");
        const store = tx.objectStore(INBOX_STORE_NAME);
        store.put({ messageId, payload, timestamp: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * 获取所有收件箱消息并按时间排序
 */
async function getAllInboxMessages(): Promise<any[]> {
    const db = await openInboxDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(INBOX_STORE_NAME, "readonly");
        const store = tx.objectStore(INBOX_STORE_NAME);
        const req = store.getAll();
        req.onsuccess = () => {
            const items = req.result;
            items.sort((a, b) => a.timestamp - b.timestamp);
            resolve(items);
        };
        req.onerror = () => reject(req.error);
    });
}

/**
 * 从收件箱中删除指定消息
 */
async function deleteFromInbox(messageId: string): Promise<void> {
    const db = await openInboxDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(INBOX_STORE_NAME, "readwrite");
        const store = tx.objectStore(INBOX_STORE_NAME);
        store.delete(messageId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * 排空收件箱，将消息转交宿主落库，跨标签页加锁
 */
export async function drainInbox(): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.locks) return;
    
    // ① 取跨标签互斥锁（Web Locks），全程持有
    await navigator.locks.request("ai-phone-push-drain-lock", async () => {
        try {
            // ② 读出全部收件箱项，按发送时刻升序排列
            const items = await getAllInboxMessages();
            if (items.length === 0) return;
            
            // ③ 逐条处理
            for (const item of items) {
                const { messageId, payload } = item;
                
                // 去重：已在环形表中，只清箱
                if (_recentHandledMessageIds.includes(messageId)) {
                    await deleteFromInbox(messageId);
                    continue;
                }
                
                const meta = payload?.metadata || {};
                
                // 测试标记或空正文，只清箱
                if (meta.isTest || !payload.messages || payload.messages.length === 0) {
                    await deleteFromInbox(messageId);
                    continue;
                }
                
                // 找不到对应会话（暂无，宿主流是自动创建或报错。对于没有 charId 的，保留并等待重试）
                if (!meta.charId) {
                    console.warn("[Drain] Inbox message missing charId, skipping", messageId);
                    continue;
                }
                
                const contentText = payload.messages[payload.messages.length - 1]?.content || "";
                
                try {
                    // ④ 正常落库
                    pushChatMessage({
                        sessionId: meta.sessionId || meta.charId, // 需要保证 sessionId 能对上
                        role: "assistant",
                        content: contentText,
                        origin: meta.origin || "push_service", // 标记来源避免产生自激
                        statusPanel: payload.statusPanel, // 根据实际推送解析结构挂载
                        innerMonologue: payload.innerMonologue,
                        reasoningText: payload.reasoningText
                    });
                    
                    // 记录到内存环形表，并控制长度
                    _recentHandledMessageIds.push(messageId);
                    if (_recentHandledMessageIds.length > RECENT_MESSAGES_LIMIT) {
                        _recentHandledMessageIds.shift();
                    }
                    
                    // 落库成功后删除收件箱项（必须在后面）
                    await deleteFromInbox(messageId);
                } catch (e) {
                    // ⑤ 落库失败：保留，等下次 drain
                    console.error("[Drain] Failed to persist message, keeping in inbox:", e);
                }
            }
        } catch (e) {
            console.error("[Drain] Error during drain procedure:", e);
        }
    });
}

// 绑定全局 drain 触发器
if (typeof window !== "undefined") {
    // 页面恢复可见时触发
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            drainInbox();
        }
    });
    
    // SW 发来广播时触发
    navigator.serviceWorker?.addEventListener("message", (event) => {
        if (event.data && event.data.type === "amsg-push-received") {
            // 先写入收件箱
            saveToInbox(event.data.messageId, event.data.payload)
                .then(() => drainInbox())
                .catch(e => console.error("Failed to save inbox item via SW message", e));
        }
    });
    
    // 初始化时触发一次
    window.addEventListener("load", () => {
        setTimeout(drainInbox, 1000);
    });
}
