import type { PaseoApi } from "@getpaseo/client";

/** 解析本机 serverId 是一次性的，失败也缓存 null，避免每张卡片都去问一遍 */
let serverIdPromise: Promise<string | null> | null = null;

function resolveServerId(paseo: PaseoApi): Promise<string | null> {
  if (!serverIdPromise) {
    serverIdPromise = Promise.race([
      paseo.hosts
        .list()
        .then((directory) => directory.self.serverId || null)
        .catch(() => null),
      // hosts.list 卡住时不能让通知跟着卡住
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    void serverIdPromise.then((serverId) => {
      console.log(
        serverId
          ? `[paseo-feishu] 深链前缀已就绪：${serverId}`
          : "[paseo-feishu] 未取到 serverId，卡片不提供「打开 Paseo」",
      );
    });
  }
  return serverIdPromise;
}

/** 生成 Paseo 深链，格式与 @getpaseo/protocol 的 buildAgentDeepLink 一致 */
export async function agentLink(paseo: PaseoApi, agentId: string): Promise<string | null> {
  const serverId = await resolveServerId(paseo);
  if (!serverId) return null;
  return `paseo:/h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agentId)}`;
}
