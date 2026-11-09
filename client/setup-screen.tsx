import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { openExternalUrl, useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  ScrollView,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Text, View } from "react-native";
import { notifyTestRpc, registrationBeginRpc, registrationPollRpc } from "../shared/rpc";
import { feishuSettings, type FeishuSettingsValues } from "../shared/settings";

type Brand = FeishuSettingsValues["brand"];
type TargetKind = FeishuSettingsValues["targetKind"];

type ScanState =
  | { phase: "idle" }
  | { phase: "starting" }
  | {
      phase: "waiting";
      sessionId: string;
      qrDataUri: string;
      qrUrl: string;
      userCode: string;
      intervalSeconds: number;
      expireInSeconds: number;
    }
  | { phase: "success"; appId: string }
  | { phase: "failed"; message: string };

const BRAND_OPTIONS = [
  { label: "飞书（国内版）", value: "feishu" },
  { label: "Lark（国际版）", value: "lark" },
] as const;

const TARGET_KIND_OPTIONS = [
  { label: "群 / 会话 chat_id", value: "chat_id" },
  { label: "用户 open_id（私聊）", value: "open_id" },
] as const;

const BRAND_LABELS: Record<Brand, string> = { feishu: "飞书", lark: "Lark" };

export function FeishuSettingsScreen({ theme, layout }: PluginScreenProps) {
  const settings = useSettings(feishuSettings);
  const beginRegistration = useRpc(registrationBeginRpc);
  const pollRegistration = useRpc(registrationPollRpc);
  const sendTestMessage = useRpc(notifyTestRpc);

  const [scan, setScan] = useState<ScanState>({ phase: "idle" });
  const [notice, setNotice] = useState<string | null>(null);

  const [draftAppId, setDraftAppId] = useState("");
  const [draftAppSecret, setDraftAppSecret] = useState("");
  const [draftTargetId, setDraftTargetId] = useState("");
  const [draftBrand, setDraftBrand] = useState<Brand>("feishu");
  const [draftTargetKind, setDraftTargetKind] = useState<TargetKind>("chat_id");
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [testing, setTesting] = useState(false);

  const ready = settings.status === "ready" ? settings : null;

  const savePatch = useCallback(
    async (values: Partial<FeishuSettingsValues>) => {
      if (!ready) return false;
      return ready.save({ ...ready.values, ...values }, ready.revision);
    },
    [ready],
  );

  // 轮询回调里要用最新的 save，但不希望 settings 变化重跑轮询
  const saveRef = useRef(savePatch);
  useEffect(() => {
    saveRef.current = savePatch;
  }, [savePatch]);

  // 配置首次就绪时把值灌进表单草稿
  useEffect(() => {
    if (!ready || draftLoaded) return;
    setDraftAppId(ready.values.appId);
    setDraftAppSecret(ready.values.appSecret);
    setDraftTargetId(ready.values.targetId);
    setDraftBrand(ready.values.brand);
    setDraftTargetKind(ready.values.targetKind);
    setDraftLoaded(true);
  }, [ready, draftLoaded]);

  const scanSessionId = scan.phase === "waiting" ? scan.sessionId : null;

  useEffect(() => {
    if (!scanSessionId || scan.phase !== "waiting") return;
    const { intervalSeconds } = scan;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const result = await pollRegistration({ sessionId: scanSessionId });
        if (cancelled) return;

        if (result.status === "pending") {
          timer = setTimeout(tick, intervalSeconds * 1000);
          return;
        }
        if (result.status === "success") {
          const keepTarget = Boolean(draftTargetId.trim());
          const saved = await saveRef.current({
            appId: result.appId,
            appSecret: result.appSecret,
            brand: result.brand,
            ...(keepTarget
              ? {}
              : { targetId: result.openId, targetKind: "open_id" as const }),
          });
          if (cancelled) return;
          setDraftAppId(result.appId);
          setDraftAppSecret(result.appSecret);
          setDraftBrand(result.brand);
          if (!keepTarget && result.openId) {
            setDraftTargetId(result.openId);
            setDraftTargetKind("open_id");
          }
          if (saved) {
            setScan({ phase: "success", appId: result.appId });
          } else {
            setScan({ phase: "failed", message: "扫码成功，但写入配置失败" });
          }
          return;
        }
        if (result.status === "denied") {
          setScan({ phase: "failed", message: "你在飞书里拒绝了授权" });
          return;
        }
        if (result.status === "expired") {
          setScan({ phase: "failed", message: "二维码已过期，请重新生成" });
          return;
        }
        setScan({ phase: "failed", message: result.message });
      } catch (error) {
        if (!cancelled) {
          setScan({ phase: "failed", message: String(error) });
        }
      }
    };

    timer = setTimeout(tick, intervalSeconds * 1000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // 只在会话变化时重跑；draftTargetId 用当前值即可，不必进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanSessionId, intervalSecondsOf(scan)]);

  const startScan = async () => {
    setNotice(null);
    setScan({ phase: "starting" });
    try {
      const result = await beginRegistration({ brand: draftBrand });
      setScan({ phase: "waiting", ...result });
    } catch (error) {
      setScan({ phase: "failed", message: String(error) });
    }
  };

  const saveDraft = async () => {
    const ok = await savePatch({
      appId: draftAppId.trim(),
      appSecret: draftAppSecret.trim(),
      targetId: draftTargetId.trim(),
      brand: draftBrand,
      targetKind: draftTargetKind,
    });
    setNotice(ok ? "配置已保存" : "保存失败，配置可能已在别处修改");
  };

  const runTest = async () => {
    setNotice(null);
    setTesting(true);
    try {
      const result = await sendTestMessage({});
      setNotice(
        result.status === "ok"
          ? "测试卡片已发出，去飞书看看"
          : `发送失败：${result.message}`,
      );
    } catch (error) {
      setNotice(`发送失败：${String(error)}`);
    } finally {
      setTesting(false);
    }
  };

  const configured = Boolean(ready?.values.appId && ready?.values.appSecret);

  const styles = {
    body: {
      flex: 1,
      backgroundColor: theme.colors.surface0,
    },
    content: {
      padding: layout.compact ? 16 : 24,
      gap: 16,
    },
    text: { color: theme.colors.foreground },
    muted: { color: theme.colors.foregroundMuted },
    card: {
      backgroundColor: theme.colors.surface1,
      borderRadius: 12,
      padding: 16,
      gap: 8,
    },
    qrWrap: {
      alignItems: "center" as const,
      gap: 8,
      paddingVertical: 8,
    },
    qr: { width: 240, height: 240, borderRadius: 8, backgroundColor: "#fff" },
    code: {
      color: theme.colors.foreground,
      fontSize: 20,
      letterSpacing: 4,
    },
  };

  return (
    <ScrollView style={styles.body} contentContainerStyle={styles.content}>
      <SettingsSection title="连接状态">
        <SettingsRow
          label={configured ? `已连接（${BRAND_LABELS[ready?.values.brand ?? "feishu"]}）` : "未配置"}
          hint={configured ? `App ID：${ready?.values.appId}` : "扫码或手动填写下面的配置"}
        />
        {ready?.values.targetId ? (
          <SettingsRow
            label="通知目标"
            hint={`${ready.values.targetKind}：${ready.values.targetId}`}
          />
        ) : (
          <SettingsRow label="通知目标" hint="扫码后会自动填成你的私聊" />
        )}
      </SettingsSection>

      <SettingsSection
        title="扫码创建机器人"
        info="用飞书扫下面的二维码，按提示创建一个 Personal Agent 应用，配置会自动写入"
      >
        {scan.phase === "idle" || scan.phase === "failed" ? (
          <>
            {scan.phase === "failed" ? (
              <SettingsRow label="上次扫码未完成" error={scan.message} />
            ) : null}
            <SettingsAction
              label="准备中"
              actionLabel="生成二维码"
              onPress={() => void startScan()}
            />
          </>
        ) : null}

        {scan.phase === "starting" ? (
          <View style={[styles.qrWrap, { paddingVertical: 24 }]}>
            <ActivityIndicator />
            <Text style={styles.muted}>正在向飞书申请二维码…</Text>
          </View>
        ) : null}

        {scan.phase === "waiting" ? (
          <View style={styles.qrWrap}>
            <Image source={{ uri: scan.qrDataUri }} style={styles.qr} resizeMode="contain" />
            <Text style={styles.text}>用飞书扫码，或手动输入下方配对码</Text>
            <Text style={styles.code}>{scan.userCode}</Text>
            <Text style={styles.muted}>
              二维码约 {Math.round(scan.expireInSeconds / 60)} 分钟内有效，扫码后会自动完成
            </Text>
            <SettingsAction
              label="等待授权"
              actionLabel="取消"
              onPress={() => setScan({ phase: "idle" })}
            />
          </View>
        ) : null}

        {scan.phase === "success" ? (
          <View style={styles.card}>
            <Text style={styles.text}>已连接 {scan.appId}</Text>
            <Text style={styles.muted}>下面点「发送测试消息」验证能否收到卡片</Text>
          </View>
        ) : null}
      </SettingsSection>

      <SettingsSection title="手动配置" info="已有飞书应用时可以直接填，与扫码结果等价">
        {draftLoaded ? (
          <>
            <SettingsInput
              label="App ID"
              hint="开放平台里的 cli_ 开头的一串"
              initialValue={draftAppId}
              onChangeText={setDraftAppId}
              placeholder="cli_xxxxxxxxxxxx"
            />
            <SettingsInput
              label="App Secret"
              initialValue={draftAppSecret}
              onChangeText={setDraftAppSecret}
              placeholder="应用凭证里的 App Secret"
              secureTextEntry
            />
            <SettingsSelect
              label="开放平台"
              value={draftBrand}
              options={BRAND_OPTIONS}
              onValueChange={(value: Brand) => setDraftBrand(value)}
            />
            <SettingsSelect
              label="目标类型"
              value={draftTargetKind}
              options={TARGET_KIND_OPTIONS}
              onValueChange={(value: TargetKind) => setDraftTargetKind(value)}
            />
            <SettingsInput
              label="目标 ID"
              hint="私聊填 open_id（ou_ 开头），群聊填 chat_id（oc_ 开头）"
              initialValue={draftTargetId}
              onChangeText={setDraftTargetId}
              placeholder="ou_xxxxxxxxxxxx"
            />
            <SettingsAction
              label="写入配置"
              actionLabel="保存"
              onPress={() => void saveDraft()}
            />
          </>
        ) : (
          <SettingsRow label="正在读取配置" hint="稍等一下" />
        )}
      </SettingsSection>

      <SettingsSection title="通知开关">
        <SettingsSwitch
          label="会话完成"
          value={ready?.values.notifyCompleted ?? true}
          onValueChange={(value) => void savePatch({ notifyCompleted: value })}
          disabled={!ready}
        />
        <SettingsSwitch
          label="会话失败"
          value={ready?.values.notifyFailed ?? true}
          onValueChange={(value) => void savePatch({ notifyFailed: value })}
          disabled={!ready}
        />
        <SettingsSwitch
          label="会话取消"
          hint="默认关闭，避免打扰"
          value={ready?.values.notifyCanceled ?? false}
          onValueChange={(value) => void savePatch({ notifyCanceled: value })}
          disabled={!ready}
        />
        <SettingsSwitch
          label="审批请求"
          value={ready?.values.notifyPermission ?? true}
          onValueChange={(value) => void savePatch({ notifyPermission: value })}
          disabled={!ready}
        />
      </SettingsSection>

      <SettingsSection title="验证">
        <SettingsAction
          label={testing ? "发送中…" : "发送测试消息"}
          actionLabel="发送"
          onPress={() => void runTest()}
          disabled={!configured || !ready?.values.targetId || testing}
        />
        {notice ? <SettingsRow label="结果" hint={notice} /> : null}
        <SettingsAction
          label="飞书开放平台"
          actionLabel="打开"
          onPress={() =>
            void openExternalUrl(
              draftBrand === "lark"
                ? "https://open.larksuite.com/app"
                : "https://open.feishu.cn/app",
            )
          }
        />
      </SettingsSection>

      <SettingsSection title="品牌">
        <SettingsRow
          label="二维码请用对应的 App 扫"
          hint={`当前选择：${BRAND_LABELS[draftBrand]}。国际版账号请切到 Lark 再生成`}
        />
      </SettingsSection>
    </ScrollView>
  );
}

function intervalSecondsOf(state: ScanState): number {
  return state.phase === "waiting" ? state.intervalSeconds : 0;
}
