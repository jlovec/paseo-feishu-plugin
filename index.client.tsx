import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { FeishuSettingsScreen } from "./client/setup-screen";

const SCREEN_ID = "feishu-settings";

function FeishuSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="MessageSquare"
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: SCREEN_ID, title: "飞书", Component: FeishuSettingsScreen });
  client.addSidebarHeaderItem({ id: "feishu", title: "飞书", Component: FeishuSidebarItem });
  return () => {};
}
