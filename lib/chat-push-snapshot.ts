// lib/chat-push-snapshot.ts
import { ChatSession, ChatMessage } from "./chat-storage";
import { LLMMessage } from "./llm-prompt-assembler";
import { kvGet, kvSet } from "./kv-db";

const LAST_CONFIRMED_HASH_PREFIX = "amsg-snapshot-hash:";

export type SnapshotPayload = {
    charId: string;
    charName: string;
    userName: string;
    persona?: string; // 完整 system prompt（增量时可省）
    personaHash: string;
    recentMessages: ChatMessage[];
    apiUrl: string;
    apiKey: string;
    model: string;
    snapshotVersion: number;
};

// 简单 SHA-256 哈希辅助函数
async function sha256(text: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 提取组装后 messages 中的系统人设部分并计算哈希
 */
export async function buildPersonaSnapshot(llmMessages: LLMMessage[]): Promise<{ persona: string; hash: string }> {
    // 过滤出系统设定和历史背景，剔除掉最近的对话轮次
    // 一般认为是深层 (depth较大) 的 system 和 assistant message
    const personaParts = llmMessages
        .filter(m => m.role === "system" || (m.role === "assistant" && m._debugMeta?.depth && m._debugMeta.depth > 50))
        .map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
        
    const persona = personaParts.join("\n\n");
    const hash = await sha256(persona);
    return { persona, hash };
}

/**
 * 提取最近 30 条纯文本聊天记录供服务端短上下文使用
 */
export function extractRecentMessagesForSnapshot(history: ChatMessage[]): ChatMessage[] {
    return history
        .filter(m => m.role === "user" || m.role === "assistant")
        .slice(-30) // 取最近 30 条
        .map(m => ({
             ...m,
             // 剥离体积过大的图像数据，只保留文本
             mediaUrl: undefined, 
             mediaData: m.mediaData ? { ...m.mediaData, stickerUrl: undefined } : undefined
        }));
}

/**
 * 获取本地已确认的哈希
 */
function getLastConfirmedHash(charId: string): string | null {
    return kvGet(LAST_CONFIRMED_HASH_PREFIX + charId);
}

/**
 * 记录服务端已确认的哈希
 */
function setLastConfirmedHash(charId: string, hash: string) {
    kvSet(LAST_CONFIRMED_HASH_PREFIX + charId, hash);
}

/**
 * 执行快照同步
 * 如果 isKeepalive = true，使用 fetch 的 keepalive 保证页面卸载时发得出去
 */
export async function syncSnapshotToServer(
    session: ChatSession,
    charName: string,
    userName: string,
    llmMessages: LLMMessage[],
    history: ChatMessage[],
    apiConfig: { baseUrl: string; apiKey: string; model: string },
    isKeepalive = false
): Promise<void> {
    
    const { persona, hash } = await buildPersonaSnapshot(llmMessages);
    const recentMessages = extractRecentMessagesForSnapshot(history);
    
    // 版本单调递增，简单用时间戳
    const snapshotVersion = Date.now();
    
    const lastHash = getLastConfirmedHash(session.contactId);
    const isIncremental = (lastHash === hash);
    
    const payload: SnapshotPayload = {
        charId: session.contactId,
        charName,
        userName,
        personaHash: hash,
        recentMessages,
        apiUrl: apiConfig.baseUrl,
        apiKey: apiConfig.apiKey,
        model: apiConfig.model,
        snapshotVersion
    };
    
    // 哈希不一致时才带上全量 persona
    if (!isIncremental) {
        payload.persona = persona;
    }
    
    // TODO: 这里需要替换为你的调度服务真实地址
    const SCHEDULE_SERVER_URL = localStorage.getItem("amsg-schedule-url") || "http://localhost:3000/snapshot";
    
    try {
        const response = await fetch(SCHEDULE_SERVER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            keepalive: isKeepalive
        });
        
        if (response.ok) {
            // 成功后记录确认的 hash
            setLastConfirmedHash(session.contactId, hash);
        } else if (response.status === 409) {
            // 假设服务端返回 409 表示要求全量
            if (isIncremental) {
                // 立即重发全量
                payload.persona = persona;
                await fetch(SCHEDULE_SERVER_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                    keepalive: isKeepalive
                });
                setLastConfirmedHash(session.contactId, hash);
            }
        }
    } catch (e) {
        console.warn("[Snapshot] Sync failed", e);
    }
}
