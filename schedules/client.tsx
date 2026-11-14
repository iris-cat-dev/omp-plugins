import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PluginClientContext, PluginSurfaceProps } from "@omp-desktop/plugin";
import { i18n } from "./ui/i18n";
import { ThemeContext } from "./ui/controls";
import { SchedulesPage } from "./ui/page";

export default function setup(ctx: PluginClientContext) {
  if (ctx.mode !== "active") return;
  function Page(props: PluginSurfaceProps) {
    const { i18n: hostI18n } = useTranslation();
    const [readyLanguage, setReadyLanguage] = useState(i18n.language);
    const language = hostI18n.language.startsWith("zh") ? "zh-CN" : "en";
    useEffect(() => { void i18n.changeLanguage(language).then(() => { if (!ctx.signal.aborted) setReadyLanguage(language); }); }, [language]);
    return <ThemeContext.Provider value={props.theme}><SchedulesPage {...props} ctx={ctx} key={props.host.id} language={readyLanguage} /></ThemeContext.Provider>;
  }
  ctx.addSurface("schedules", Page);
  ctx.addSidebarItem({ id: "schedules", title: "计划任务 / Schedules", icon: "calendar-clock", surface: "schedules" });
  ctx.addCommandCenterItem({
    id: "schedules.open",
    title: "计划任务 / Schedules",
    icon: "calendar-clock",
    context: "global",
    keywords: ["schedules", "scheduled", "automation", "recurring", "计划任务"],
    onSelect: ({ openSurface }) => openSurface("schedules"),
  });
}
