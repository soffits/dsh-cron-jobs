/*
 * Browser half of dsh-cron-jobs: the "Cron tasks" sidebar entry and page.
 *
 * Plain JavaScript in DSH's Client module format (no build step). React
 * comes from the page's module table. The page talks to the Host half over
 * authenticated routes under DSH's `/api` channel (see src/rpc.js).
 *
 * Layout, spacing and colours follow DSH's own Automation tasks page
 * (@deepseek-ai/dsh-client-ui-schedule); styles use only the host theme
 * tokens (--dsw-*). Icon paths are copied from DSH's icon set (MIT).
 */
window.__ModuleLoader__.load({
  id: 'dsh-cron-jobs',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback } = React

    const NS = 'dsh-cron-jobs'
    const PANEL = 'dsh-cron-jobs'
    // Relative to the page, like DSH's own API calls, so a sub-path deployment works.
    const API_BASE = 'api/dsh-cron-jobs/'
    const POLL_MS = 5000
    const STYLE_ID = 'dsh-cron-jobs'

    // ---------------------------------------------------------------- text

    const en = {
      panel: 'Cron tasks',
      title: 'Cron tasks',
      'time.locale': 'en-US',
      'heading.note': 'Jobs are defined in the plugin config.',
      'filter.label': 'Status',
      'filter.all': 'All',
      'filter.active': 'Active',
      'filter.paused': 'Paused',
      'filter.off': 'Off',
      'search.label': 'Search cron tasks',
      'search.placeholder': 'Search by name or command',
      'search.clear': 'Clear search',
      'list.label': 'Cron tasks',
      'list.empty': 'No cron jobs configured yet. Add jobs to the plugin config.',
      'list.noMatches': 'No matching cron tasks',
      'list.emptyFilter': 'No cron tasks here',
      'list.next': 'Next ',
      'list.last': 'Last: ',
      'list.running': 'Running since {time}',
      'state.active': 'Active',
      'state.paused': 'Paused',
      'state.disabled': 'Off in config',
      'state.invalid': 'Invalid schedule',
      'load.error': 'Could not load cron tasks.',
      'load.retry': 'Retry',
      'load.loading': 'Loading…',
      'detail.tabs': 'Task views',
      'detail.settings': 'Settings',
      'detail.runs': 'Runs',
      'detail.more': 'More actions',
      'detail.close': 'Close',
      'detail.nextRun': 'Next run ',
      'detail.noNextRun': 'No upcoming run',
      'detail.pause': 'Pause schedule',
      'detail.resume': 'Resume schedule',
      'detail.pauseUnavailable': 'Turned off in the plugin config',
      'detail.runNow': 'Run now',
      'detail.runBusy': 'Already running',
      'detail.started': 'Started a run.',
      'detail.pauseError': 'Could not change the schedule: {message}',
      'detail.runError': 'Could not start the run: {message}',
      'notice.disabled': 'This job has enabled: false in the plugin config, so it is not scheduled. A pause set here applies again once it is enabled. Run now still works.',
      'notice.invalid': 'Not scheduled: {error}',
      'notice.paused': 'Paused since {time}. Scheduled runs are skipped until you resume; Run now still works.',
      'notice.pausedNoTime': 'Paused. Scheduled runs are skipped until you resume; Run now still works.',
      'notice.running': 'Running since {time} ({trigger}).',
      'notice.memory': 'Run history is kept in memory only because DSH storage is unavailable; it is lost on restart.',
      'field.schedule': 'Schedule',
      'field.timeZone': 'Time zone',
      'field.timeZoneHost': 'Host time zone',
      'field.command': 'Command',
      'field.cwd': 'Working directory',
      'field.cwdHost': 'Host process directory',
      'field.timeout': 'Time limit',
      'field.timeoutNone': 'No limit',
      'field.timeoutValue': '{seconds} s',
      'field.kind': 'Type',
      'field.kindPlain': 'Plain command',
      'field.kindGated': 'Gate: wakes an agent when the command reports work',
      'field.preset': 'Agent preset',
      'field.presetDefault': 'Host default',
      'field.agentCwd': 'Session directory',
      'field.model': 'Model',
      'field.modelDefault': 'Preset or host default',
      'field.effort': 'Reasoning effort',
      'field.prompt': 'Agent prompt',
      'field.cwdFromDefault': 'plugin default',
      'field.cwdFromCommand': 'command directory',
      'field.autoArchive': 'Auto-archive',
      'field.autoArchiveOn': 'Archive the session after its turn ends (kept if pinned or taken over by a person)',
      'field.autoArchiveOff': 'Off',
      'field.reuse': 'Session reuse',
      'field.reuseOff': 'Off: every wake opens a new session',
      'field.reuseValue': 'Reuse the previous session for {hours} h after it was opened',
      'run.reused': 'Reused session',
      'run.queued': 'queued behind a running turn',
      'run.reuseFailed': 'new session (reuse not possible)',
      'archive.pending': 'archive after the turn',
      'archive.archived': 'archived',
      'archive.kept': 'not archived',
      'archive.superseded': 'continued by a later run',
      'runs.empty': 'No runs yet.',
      'runs.retention': 'The last {count} runs of each job are kept.',
      'runs.loadError': 'Could not load runs.',
      'trigger.schedule': 'Scheduled',
      'trigger.manual': 'Run now',
      'run.exit': 'Exit code {code}',
      'run.duration': '{duration}',
      'run.openSession': 'Open woken session',
      'run.showOutput': 'Show output',
      'run.hideOutput': 'Hide output',
      'run.stdout': 'stdout',
      'run.stderr': 'stderr',
      'run.noOutput': 'No output.',
      'status.running': 'Running',
      'status.done': 'Succeeded',
      'status.idle': 'Nothing to do',
      'status.woke': 'Woke an agent',
      'status.failed': 'Failed',
      'status.wake-failed': 'Could not wake the agent',
      'status.interrupted': 'Interrupted',
      'footer.latestSession': 'Latest woken session',
      'footer.noSession': 'No agent woken yet',
    }

    const zh = {
      panel: '定时命令',
      title: '定时命令',
      'time.locale': 'zh-CN',
      'heading.note': '任务在插件配置中定义。',
      'filter.label': '状态',
      'filter.all': '全部',
      'filter.active': '运行中',
      'filter.paused': '已暂停',
      'filter.off': '未启用',
      'search.label': '搜索定时命令',
      'search.placeholder': '按名称或命令搜索',
      'search.clear': '清除搜索',
      'list.label': '定时命令',
      'list.empty': '还没有配置定时命令，请在插件配置中添加。',
      'list.noMatches': '没有匹配的定时命令',
      'list.emptyFilter': '这里没有定时命令',
      'list.next': '下次 ',
      'list.last': '上次：',
      'list.running': '自 {time} 起运行中',
      'state.active': '运行中',
      'state.paused': '已暂停',
      'state.disabled': '配置中已关闭',
      'state.invalid': '计划无效',
      'load.error': '无法加载定时命令。',
      'load.retry': '重试',
      'load.loading': '加载中…',
      'detail.tabs': '任务视图',
      'detail.settings': '设置',
      'detail.runs': '运行记录',
      'detail.more': '更多操作',
      'detail.close': '关闭',
      'detail.nextRun': '下次运行 ',
      'detail.noNextRun': '没有待运行的计划',
      'detail.pause': '暂停计划',
      'detail.resume': '恢复计划',
      'detail.pauseUnavailable': '已在插件配置中关闭',
      'detail.runNow': '立即运行',
      'detail.runBusy': '正在运行',
      'detail.started': '已开始运行。',
      'detail.pauseError': '无法更改计划：{message}',
      'detail.runError': '无法开始运行：{message}',
      'notice.disabled': '此任务在插件配置中为 enabled: false，不会按计划运行。在这里设置的暂停会在重新启用后生效。仍可立即运行。',
      'notice.invalid': '未按计划运行：{error}',
      'notice.paused': '自 {time} 起暂停。恢复前跳过计划运行；仍可立即运行。',
      'notice.pausedNoTime': '已暂停。恢复前跳过计划运行；仍可立即运行。',
      'notice.running': '自 {time} 起运行中（{trigger}）。',
      'notice.memory': 'DSH 存储不可用，运行记录只保存在内存中，重启后会丢失。',
      'field.schedule': '计划',
      'field.timeZone': '时区',
      'field.timeZoneHost': '主机时区',
      'field.command': '命令',
      'field.cwd': '工作目录',
      'field.cwdHost': '主机进程目录',
      'field.timeout': '时间限制',
      'field.timeoutNone': '无限制',
      'field.timeoutValue': '{seconds} 秒',
      'field.kind': '类型',
      'field.kindPlain': '普通命令',
      'field.kindGated': '门控：命令报告有事时唤醒智能体',
      'field.preset': '智能体预设',
      'field.presetDefault': '主机默认',
      'field.agentCwd': '会话目录',
      'field.model': '模型',
      'field.modelDefault': '预设或主机默认',
      'field.effort': '推理强度',
      'field.prompt': '智能体提示词',
      'field.cwdFromDefault': '插件默认',
      'field.cwdFromCommand': '命令目录',
      'field.autoArchive': '自动归档',
      'field.autoArchiveOn': '回合结束后归档会话（已置顶或有人接手的会话不归档）',
      'field.autoArchiveOff': '关闭',
      'field.reuse': '复用会话',
      'field.reuseOff': '关闭：每次唤醒都开新会话',
      'field.reuseValue': '会话打开后 {hours} 小时内复用上一个会话',
      'run.reused': '复用了会话',
      'run.queued': '排在正在进行的回合之后',
      'run.reuseFailed': '新会话（无法复用）',
      'archive.pending': '回合结束后归档',
      'archive.archived': '已归档',
      'archive.kept': '未归档',
      'archive.superseded': '由后续运行接续',
      'runs.empty': '还没有运行记录。',
      'runs.retention': '每个任务保留最近 {count} 次运行。',
      'runs.loadError': '无法加载运行记录。',
      'trigger.schedule': '按计划',
      'trigger.manual': '立即运行',
      'run.exit': '退出码 {code}',
      'run.duration': '{duration}',
      'run.openSession': '打开唤醒的会话',
      'run.showOutput': '显示输出',
      'run.hideOutput': '隐藏输出',
      'run.stdout': '标准输出',
      'run.stderr': '标准错误',
      'run.noOutput': '没有输出。',
      'status.running': '运行中',
      'status.done': '成功',
      'status.idle': '无事可做',
      'status.woke': '已唤醒智能体',
      'status.failed': '失败',
      'status.wake-failed': '唤醒智能体失败',
      'status.interrupted': '已中断',
      'footer.latestSession': '最近唤醒的会话',
      'footer.noSession': '尚未唤醒智能体',
    }

    // --------------------------------------------------------------- icons

    function icon(viewBox, paths) {
      return function Icon({ size = 16, className }) {
        return h('svg', {
          width: size, height: size, viewBox, fill: 'none', strokeWidth: 1,
          className, 'aria-hidden': true, focusable: 'false',
        }, paths.map((p, i) => h('path', { key: i, d: p.d, ...(p.fill ? { fill: 'currentColor' } : { stroke: 'currentColor' }) })))
      }
    }
    const IconAlarmClock = icon('0 0 17 17', [
      { d: 'M4.09372 11.9895L3.11865 14.0387' }, { d: 'M12.1392 11.9895L13.1143 14.0387' },
      { d: 'M8.11646 4.78442V8.03442L10.6165 9.53442' },
      { d: 'M8.11646 13.4094C11.154 13.4094 13.6165 10.947 13.6165 7.90942C13.6165 4.87186 11.154 2.40942 8.11646 2.40942C5.07889 2.40942 2.61646 4.87186 2.61646 7.90942C2.61646 10.947 5.07889 13.4094 8.11646 13.4094Z' },
      { d: 'M1.75952 4.74323C2.30657 3.65639 3.12646 2.73047 4.12926 2.05542' },
      { d: 'M14.3345 4.74323C13.7874 3.65639 12.9675 2.73047 11.9647 2.05542' },
    ])
    const CIRCLE = 'M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z'
    const IconPause = icon('0 0 16 16', [{ d: CIRCLE }, { d: 'M6.5 5V11' }, { d: 'M9.5 5V11' }])
    const IconPlay = icon('0 0 16 16', [{ d: CIRCLE }, { d: 'M10.3329 7.91346C10.3996 7.95195 10.3996 8.04818 10.3329 8.08667L6.78304 10.1362C6.71638 10.1747 6.63304 10.1266 6.63304 10.0496L6.63304 5.95055C6.63304 5.87357 6.71638 5.82546 6.78304 5.86395L10.3329 7.91346Z' }])
    const IconEllipsis = icon('0 0 16 16', [
      { d: 'M3 9C3.55228 9 4 8.55228 4 8C4 7.44772 3.55228 7 3 7C2.44772 7 2 7.44772 2 8C2 8.55228 2.44772 9 3 9Z', fill: true },
      { d: 'M8 9C8.55228 9 9 8.55228 9 8C9 7.44772 8.55228 7 8 7C7.44772 7 7 7.44772 7 8C7 8.55228 7.44772 9 8 9Z', fill: true },
      { d: 'M13 9C13.5523 9 14 8.55228 14 8C14 7.44772 13.5523 7 13 7C12.4477 7 12 7.44772 12 8C12 8.55228 12.4477 9 13 9Z', fill: true },
    ])
    const IconClose = icon('0 0 16 16', [{ d: 'M2.5 2.5L13.5 13.5' }, { d: 'M13.5 2.5L2.5 13.5' }])
    const IconSearch = icon('0 0 16 16', [
      { d: 'M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z' },
      { d: 'M10.2991 10.3933L14.7783 14.8725' },
    ])
    const IconChevronRight = icon('0 0 16 16', [{ d: 'M6 12L9.29289 8.70711C9.68342 8.31658 9.68342 7.68342 9.29289 7.29289L6 4' }])

    // ---------------------------------------------------------------- styles

    // Values copied from the Automation tasks page and DSH's Button and menu
    // primitives, renamed under the `dcj-` prefix; only theme tokens are shared.
    const CSS = `
.dcj-page{width:100%;min-width:0;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;line-height:1.6;display:flex;overflow:hidden}
.dcj-listPane{flex-direction:column;flex:1;min-width:0;min-height:0;display:flex}
.dcj-pageScroll{scrollbar-gutter:stable;--dsh-scrollbar-width:9px;--dsh-scrollbar-thumb-border:2px;flex:1;min-height:0;overflow:auto}
.dcj-pageContent{max-width:960px;margin:0 auto;padding:0 clamp(24px,4vw,48px) 48px}
@media (width<=767px){.dcj-pageContent{padding-inline:20px}}
.dcj-pageHeading{flex-wrap:wrap;justify-content:space-between;align-items:center;gap:16px;margin-bottom:24px;padding-top:28px;display:flex}
[data-platform=darwin] .dcj-pageHeading{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}
.dcj-pageHeading h1{flex:0 auto;min-width:0;max-width:100%;margin:0;font-size:20px;font-weight:500;line-height:28px}
.dcj-headingNote{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.dcj-filters{flex-wrap:wrap;align-items:center;gap:8px 12px;margin-bottom:14px;display:flex}
.dcj-filterTab{height:28px;color:var(--dsw-alias-label-tertiary);font:inherit;white-space:nowrap;cursor:pointer;background:0 0;border:0;border-radius:14px;flex:none;align-items:center;padding:0 10px;font-size:14px;line-height:22px;display:inline-flex}
@media (hover:hover){.dcj-filterTab:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.dcj-filterTabActive{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dcj-searchTools{align-items:center;gap:8px;margin-bottom:16px;display:flex}
.dcj-searchField{box-sizing:border-box;min-width:0;height:36px;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);border-radius:12px;flex:1;align-items:center;gap:8px;margin:0;padding:0 10px;transition:border-color .15s;display:flex}
@media (hover:hover){.dcj-searchField:hover{border-color:var(--dsw-alias-border-l2)}}
.dcj-searchField:focus-within{border-color:var(--dsw-alias-state-business-primary)}
.dcj-searchField svg{width:14px;height:14px;flex:none}
.dcj-searchField input{flex:1;min-width:0;height:100%;background:0 0;border:0;padding:0;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;outline:none}
.dcj-searchField input::placeholder{color:var(--dsw-alias-label-caption)}
.dcj-searchField input::-webkit-search-cancel-button{display:none}
.dcj-listRows{flex-direction:column;gap:2px;margin:0;padding:0;list-style:none;display:flex}
.dcj-row{box-sizing:border-box;text-align:left;white-space:normal;border-radius:12px;justify-content:flex-start;align-items:flex-start;gap:12px;width:100%;height:auto;padding:8px;display:flex;border:0;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
@media (hover:hover){.dcj-row:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.dcj-rowGlyph{width:16px;height:20px;color:var(--dsw-alias-label-tertiary);flex:none;margin-top:2px}
.dcj-rowContent{flex-direction:column;flex:1;min-width:0;display:flex}
.dcj-rowTitle{text-overflow:ellipsis;white-space:nowrap;font-weight:500;line-height:23px;overflow:hidden}
.dcj-rowSummary{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;margin-top:2px;font-size:13px;line-height:21px;display:block}
.dcj-metadata{color:inherit;overflow-wrap:anywhere;font-size:13px;line-height:21px}
.dcj-metadata+.dcj-metadata:before{content:" · ";padding:0 2px}
.dcj-metaError{color:var(--dsw-alias-state-error-primary)}
.dcj-selectedRow{background:var(--dsw-alias-interactive-bg-hover)}
.dcj-offRow .dcj-rowTitle{color:var(--dsw-alias-label-tertiary)}
.dcj-offRow .dcj-rowSummary{color:var(--dsw-alias-label-caption)}
.dcj-selectedRow.dcj-offRow .dcj-rowTitle{color:inherit}
.dcj-notice{background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-secondary);border-radius:10px;flex-wrap:wrap;align-items:center;gap:9px;margin:0 0 20px;padding:12px 14px;font-size:12px;line-height:20px;display:flex}
.dcj-notice p{flex:1;margin:0;overflow-wrap:anywhere}
.dcj-empty{text-align:center;color:var(--dsw-alias-label-tertiary);flex-direction:column;align-items:center;padding:48px 20px;font-size:14px;display:flex}
.dcj-empty svg{color:var(--dsw-alias-label-caption);margin-bottom:12px}
.dcj-empty h2{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;font-weight:400;line-height:1.6}
.dcj-detail{--detail-gutter:24px;border-left:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-base);flex-direction:column;flex:0 0 47%;min-width:0;min-height:0;display:flex;position:relative}
.dcj-detailTabsBar{height:44px;min-height:44px;padding:0 var(--detail-gutter);border-bottom:.5px solid var(--dsw-alias-border-l3);flex-shrink:0;justify-content:space-between;align-items:center;gap:20px;display:flex}
.dcj-detailTabs{scrollbar-width:none;flex:auto;align-self:flex-end;gap:36px;min-width:0;margin-bottom:-1px;padding-bottom:1px;display:flex;overflow-x:auto}
.dcj-detailTab{color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;flex:none;padding:0 0 13px;font:inherit;font-size:13px;font-weight:500;line-height:16px;position:relative}
.dcj-detailTab:after{content:"";background:0 0;border-radius:2px;height:2px;position:absolute;bottom:-1px;left:0;right:0}
.dcj-detailTab[aria-selected=true]{color:var(--dsw-alias-state-business-primary)}
.dcj-detailTab[aria-selected=true]:after{background:var(--dsw-alias-state-business-primary)}
.dcj-detailActions{flex:none;align-items:center;gap:2px;margin-right:-8px;display:flex}
.dcj-detailScroll{min-height:0;padding:24px var(--detail-gutter) 28px;scrollbar-gutter:stable;--dsh-scrollbar-width:9px;--dsh-scrollbar-thumb-border:2px;flex:1;overflow:auto}
.dcj-detailHeader{align-items:flex-start;gap:10px;margin-bottom:4px;display:flex}
.dcj-readonlyName{overflow-wrap:anywhere;flex:1;min-width:0;margin:0;padding:2px 0;font-size:20px;font-weight:500;line-height:28px}
.dcj-nextRun{min-height:20px;color:var(--dsw-alias-label-tertiary);align-items:center;gap:6px;margin-bottom:20px;font-size:13px;line-height:20px;display:flex}
.dcj-nextRun p{overflow-wrap:anywhere;min-width:0;margin:0}
.dcj-detailNotice{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;margin:0 0 12px;font-size:12px}
.dcj-failure{color:var(--dsw-alias-state-error-primary);margin:0 0 12px;font-size:12px;line-height:1.6}
.dcj-ruleRows{border:.5px solid var(--dsw-alias-border-l3);border-radius:16px;flex-direction:column;min-width:0;padding:0 12px;display:flex}
.dcj-ruleRow{border-bottom:.5px solid var(--dsw-alias-border-l3);justify-content:space-between;align-items:center;gap:12px;min-height:48px;display:flex}
.dcj-ruleRows>:last-child{border-bottom:0}
.dcj-ruleLabel{color:var(--dsw-alias-label-primary);flex:none;font-size:14px;line-height:1.6}
.dcj-ruleValue{color:var(--dsw-alias-label-secondary);text-align:right;overflow-wrap:anywhere;min-width:0;padding:12px 0;font-size:14px;line-height:1.6}
.dcj-ruleStack{flex-direction:column;align-items:stretch;gap:0;padding:12px 0}
.dcj-ruleStack .dcj-ruleValue{text-align:left;padding:6px 0 0}
.dcj-code{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12.5px}
.dcj-pre{box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:10px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;margin:6px 0 0;padding:10px 12px;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px}
.dcj-runs{list-style:none;margin:0;padding:0}
.dcj-run{border-radius:8px;align-items:flex-start;gap:12px;margin:0 -8px;padding:14px 8px;font-size:14px;line-height:22px;display:flex;position:relative}
.dcj-run:first-of-type{padding-top:0}
.dcj-run:before,.dcj-run:after{background:var(--dsw-alias-border-l3);width:.5px;position:absolute;left:15.75px}
.dcj-run:not(:first-of-type):before{content:"";height:14px;top:0}
.dcj-run:not(:last-of-type):after{content:"";top:42px;bottom:0}
.dcj-run:first-of-type:not(:last-of-type):after{top:28px}
.dcj-runGlyph{color:var(--dsw-alias-label-tertiary);flex:none;margin-top:6px}
.dcj-runBad .dcj-runGlyph{color:var(--dsw-alias-state-error-primary)}
.dcj-runBody{flex:1;min-width:0;padding:2px 0}
.dcj-runHead{flex-wrap:wrap;align-items:center;gap:4px 10px;display:flex}
.dcj-runTime{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.dcj-runStatus{color:var(--dsw-alias-label-secondary);font-size:13px}
.dcj-runBad .dcj-runStatus{color:var(--dsw-alias-state-error-primary)}
.dcj-runMeta{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:22px}
.dcj-runActions{flex-wrap:wrap;gap:4px;margin:2px 0 0 -6px;display:flex}
.dcj-linkButton{border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;background:0 0;border:0;align-items:center;gap:2px;padding:1px 6px;font-size:12px;line-height:20px;display:inline-flex}
@media (hover:hover){.dcj-linkButton:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.dcj-outLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin-top:8px}
.dcj-retention{padding:16px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.dcj-footer{padding:16px var(--detail-gutter);border-top:.5px solid var(--dsw-alias-border-l4);justify-content:space-between;align-items:center;gap:16px;font-size:13px;display:flex}
.dcj-footerEmpty{color:var(--dsw-alias-label-tertiary)}
.dcj-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;border:none;border-radius:var(--dsw-radius-md);cursor:pointer;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent;padding:0 14px;height:36px}
.dcj-btn:disabled{cursor:not-allowed;opacity:.4}
.dcj-btnSm{height:28px;font-size:12px;line-height:18px;padding:0 10px;border-radius:var(--dsw-radius-sm)}
.dcj-btnOutline{box-shadow:inset 0 0 0 var(--dsh-hairline-width,.5px) var(--dsh-button-outline-color,var(--dsw-alias-border-l3))}
@media (hover:hover){.dcj-btnOutline:hover:not(:disabled),.dcj-btnGhost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}
.dcj-btnGhost:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.dcj-iconButton{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);flex:none;padding:0}
.dcj-iconButton[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}
.dcj-footerLink{text-overflow:ellipsis;white-space:nowrap;min-width:0;max-width:75%;overflow:hidden;height:28px;font-size:13px;padding:0 8px}
.dcj-menuRoot{display:inline-flex;position:relative}
.dcj-menu{box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);z-index:100;min-width:160px;max-width:320px;border:0;flex-direction:column;padding:4px;display:flex;position:absolute;top:calc(100% + 4px);right:0;margin:0;list-style:none}
.dcj-menuItem{border-radius:var(--dsw-radius-md);cursor:pointer;width:100%;min-height:34px;color:var(--dsw-alias-label-primary);text-align:left;background:0 0;border:none;align-items:center;gap:6px;padding:6px 8px;font:inherit;font-size:13px;line-height:20px;display:flex}
@media (hover:hover){.dcj-menuItem:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}
.dcj-menuItem:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);outline:none}
.dcj-menuItem:disabled{opacity:.4;cursor:not-allowed}
.dcj-menuItem svg{width:14px;height:14px;color:var(--dsw-alias-label-tertiary);flex:none}
.dcj-page :focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dcj-page .dcj-searchField input:focus-visible{outline:none}
@media (width<=1100px){.dcj-detail{--detail-gutter:20px}}
@media (width<=760px){.dcj-hasDetails .dcj-listPane{display:none}.dcj-detail{border-left:0;flex-basis:100%}.dcj-detailScroll{padding-top:20px}}
@media (width<=400px){.dcj-detail{--detail-gutter:16px}.dcj-detailTabsBar{gap:16px}}
@media (pointer:coarse){.dcj-searchField input{font-size:16px}}
`

    // ------------------------------------------------------------- helpers

    const cx = (...names) => names.filter(Boolean).join(' ')

    function formatAbsolute(iso, locale) {
      const date = new Date(iso)
      const sameYear = date.getFullYear() === new Date().getFullYear()
      return new Intl.DateTimeFormat(locale, {
        ...(sameYear ? {} : { year: 'numeric' }),
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      }).format(date)
    }

    function formatRelative(iso, locale, now) {
      const seconds = Math.round((Date.parse(iso) - now) / 1000)
      const abs = Math.abs(seconds)
      const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
      if (abs < 45) return rtf.format(0, 'second')
      if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute')
      if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour')
      return rtf.format(Math.round(seconds / 86400), 'day')
    }

    function formatDuration(ms, locale) {
      if (typeof ms !== 'number') return ''
      const nf = (value, unit) => new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow', maximumFractionDigits: 1 }).format(value)
      if (ms < 1000) return nf(ms, 'millisecond')
      if (ms < 60_000) return nf(ms / 1000, 'second')
      const minutes = Math.floor(ms / 60_000)
      const seconds = Math.round((ms % 60_000) / 1000)
      return `${nf(minutes, 'minute')} ${nf(seconds, 'second')}`
    }

    const BAD = new Set(['failed', 'wake-failed', 'interrupted'])
    const OFF = new Set(['disabled', 'invalid'])

    function scheduleText(job, t) {
      return job.timeZone ? `${job.cron} (${job.timeZone})` : job.cron
    }

    function modelText(model) {
      if (!model) return null
      const route = `${model.provider} / ${model.model}`
      return model.reasoningEffort ? `${route} · ${model.reasoningEffort}` : route
    }

    function stateMatches(job, filter) {
      if (filter === 'all') return true
      if (filter === 'off') return OFF.has(job.state)
      return job.state === filter
    }

    function errorMessage(result, fallback) {
      if (result && result.ok === false) return result.error?.message || result.error?.code || fallback
      return fallback
    }

    /** Close a menu on outside pointer down or Escape. */
    function useDismiss(open, onClose, rootRef) {
      useEffect(() => {
        if (!open) return undefined
        const onPointer = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) onClose()
        }
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onClose()
          }
        }
        document.addEventListener('pointerdown', onPointer, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('pointerdown', onPointer, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [open, onClose, rootRef])
    }

    // ------------------------------------------------------------ components

    function SidebarIcon({ size }) {
      return h(IconAlarmClock, { size })
    }

    function Notice({ children, action }) {
      return h('div', { className: 'dcj-notice', role: 'status' }, h('p', null, children), action)
    }

    function ListRow({ job, selected, onSelect, t, locale, now }) {
      const meta = []
      if (job.state !== 'active') {
        meta.push(h('span', { key: 'state', className: cx('dcj-metadata', job.state === 'invalid' && 'dcj-metaError') }, t(`state.${job.state}`)))
      }
      meta.push(h('span', { key: 'cron', className: 'dcj-metadata dcj-code' }, scheduleText(job, t)))
      if (job.agent?.model) meta.push(h('span', { key: 'model', className: 'dcj-metadata' }, modelText(job.agent.model)))
      if (job.running) {
        meta.push(h('span', { key: 'running', className: 'dcj-metadata' }, t('list.running', { time: formatRelative(job.running.startedAt, locale, now) })))
      } else if (job.nextRunAt) {
        meta.push(h('span', { key: 'next', className: 'dcj-metadata' },
          t('list.next'), h('time', { dateTime: job.nextRunAt }, formatAbsolute(job.nextRunAt, locale)), ' ', formatRelative(job.nextRunAt, locale, now)))
      }
      if (job.lastRun && job.lastRun.status !== 'running') {
        meta.push(h('span', { key: 'last', className: cx('dcj-metadata', BAD.has(job.lastRun.status) && 'dcj-metaError') },
          t('list.last'), t(`status.${job.lastRun.status}`), ' ', formatRelative(job.lastRun.endedAt || job.lastRun.startedAt, locale, now)))
      }
      return h('li', null, h('button', {
        type: 'button',
        className: cx('dcj-row', selected && 'dcj-selectedRow', OFF.has(job.state) && 'dcj-offRow'),
        'aria-expanded': selected,
        onClick: onSelect,
      },
      h(IconAlarmClock, { className: 'dcj-rowGlyph' }),
      h('span', { className: 'dcj-rowContent' },
        h('span', { className: 'dcj-rowTitle' }, job.name),
        h('span', { className: 'dcj-rowSummary' }, meta))))
    }

    function RuleRow({ label, children, stack }) {
      return h('div', { className: cx('dcj-ruleRow', stack && 'dcj-ruleStack') },
        h('span', { className: 'dcj-ruleLabel' }, label),
        h('span', { className: 'dcj-ruleValue' }, children))
    }

    function Settings({ job, t }) {
      const rows = [
        h(RuleRow, { key: 'schedule', label: t('field.schedule') }, h('span', { className: 'dcj-code' }, job.cron)),
        h(RuleRow, { key: 'zone', label: t('field.timeZone') }, job.timeZone || t('field.timeZoneHost')),
        h(RuleRow, { key: 'command', label: t('field.command'), stack: true }, h('pre', { className: 'dcj-pre' }, job.command)),
        h(RuleRow, { key: 'cwd', label: t('field.cwd') }, job.cwd ? h('span', { className: 'dcj-code' }, job.cwd) : t('field.cwdHost')),
        h(RuleRow, { key: 'timeout', label: t('field.timeout') }, job.timeoutSeconds > 0 ? t('field.timeoutValue', { seconds: job.timeoutSeconds }) : t('field.timeoutNone')),
        h(RuleRow, { key: 'kind', label: t('field.kind') }, t(job.gated ? 'field.kindGated' : 'field.kindPlain')),
      ]
      if (job.agent) {
        rows.push(...[
          h(RuleRow, { key: 'preset', label: t('field.preset') }, job.agent.preset || t('field.presetDefault')),
          h(RuleRow, { key: 'model', label: t('field.model') }, job.agent.model
            ? h('span', { className: 'dcj-code' }, `${job.agent.model.provider} / ${job.agent.model.model}`)
            : t('field.modelDefault')),
          job.agent.model?.reasoningEffort && h(RuleRow, { key: 'effort', label: t('field.effort') }, job.agent.model.reasoningEffort),
          h(RuleRow, { key: 'agentCwd', label: t('field.agentCwd') }, job.agent.cwd
            ? h(React.Fragment, null, h('span', { className: 'dcj-code' }, job.agent.cwd),
              job.agent.cwdSource === 'default' ? ` (${t('field.cwdFromDefault')})` : job.agent.cwdSource === 'command' ? ` (${t('field.cwdFromCommand')})` : null)
            : t('field.cwdHost')),
          h(RuleRow, { key: 'autoArchive', label: t('field.autoArchive') }, t(job.agent.autoArchive ? 'field.autoArchiveOn' : 'field.autoArchiveOff')),
          h(RuleRow, { key: 'reuse', label: t('field.reuse') }, job.agent.reuseWithinHours > 0
            ? t('field.reuseValue', { hours: job.agent.reuseWithinHours })
            : t('field.reuseOff')),
          h(RuleRow, { key: 'prompt', label: t('field.prompt'), stack: true }, h('pre', { className: 'dcj-pre' }, job.agent.prompt)),
        ].filter(Boolean))
      }
      return h('div', { className: 'dcj-ruleRows' }, rows)
    }

    function RunItem({ run, t, locale, onOpenSession }) {
      const [open, setOpen] = useState(false)
      const bad = BAD.has(run.status)
      const meta = [t(`trigger.${run.trigger}`)]
      if (typeof run.durationMs === 'number') meta.push(formatDuration(run.durationMs, locale))
      if (typeof run.exitCode === 'number') meta.push(t('run.exit', { code: run.exitCode }))
      if (run.outcome && !/^exit \d+$/.test(run.outcome)) meta.push(run.outcome)
      if (run.reused) meta.push(run.queued ? `${t('run.reused')} (${t('run.queued')})` : t('run.reused'))
      else if (run.reuseNote) meta.push(t('run.reuseFailed'))
      if (run.archive) meta.push(t(`archive.${run.archive}`) + (run.archiveNote ? `: ${run.archiveNote}` : ''))
      const hasOutput = Boolean(run.stdoutTail || run.stderrTail || run.error || run.reuseNote)
      return h('li', { className: cx('dcj-run', bad && 'dcj-runBad') },
        h(IconAlarmClock, { className: 'dcj-runGlyph' }),
        h('div', { className: 'dcj-runBody' },
          h('div', { className: 'dcj-runHead' },
            h('time', { className: 'dcj-runTime', dateTime: run.startedAt }, formatAbsolute(run.startedAt, locale)),
            h('span', { className: 'dcj-runStatus' }, t(`status.${run.status}`))),
          h('div', { className: 'dcj-runMeta' }, meta.join(' · ')),
          (run.sessionId || run.status !== 'running') && h('div', { className: 'dcj-runActions' },
            run.sessionId && h('button', { type: 'button', className: 'dcj-linkButton', onClick: () => onOpenSession(run.sessionId) },
              t('run.openSession'), h(IconChevronRight, { size: 14 })),
            run.status !== 'running' && h('button', { type: 'button', className: 'dcj-linkButton', 'aria-expanded': open, onClick: () => setOpen(v => !v) },
              t(open ? 'run.hideOutput' : 'run.showOutput'))),
          open && (hasOutput
            ? h(React.Fragment, null,
              run.error && h('pre', { className: 'dcj-pre' }, run.error),
              run.reuseNote && h('pre', { className: 'dcj-pre' }, run.reuseNote),
              run.stdoutTail && h(React.Fragment, null, h('div', { className: 'dcj-outLabel' }, t('run.stdout')), h('pre', { className: 'dcj-pre' }, run.stdoutTail)),
              run.stderrTail && h(React.Fragment, null, h('div', { className: 'dcj-outLabel' }, t('run.stderr')), h('pre', { className: 'dcj-pre' }, run.stderrTail)))
            : h('div', { className: 'dcj-runMeta' }, t('run.noOutput')))))
    }

    function Runs({ runs, error, retention, t, locale, onOpenSession, onRetry }) {
      if (error) return h(Notice, { action: h('button', { type: 'button', className: 'dcj-btn dcj-btnSm dcj-btnOutline', onClick: onRetry }, t('load.retry')) }, t('runs.loadError'))
      if (runs === undefined) return h('p', { className: 'dcj-detailNotice' }, t('load.loading'))
      if (runs.length === 0) return h('p', { className: 'dcj-detailNotice' }, t('runs.empty'))
      return h(React.Fragment, null,
        h('ul', { className: 'dcj-runs' }, runs.map(run => h(RunItem, { key: run.id, run, t, locale, onOpenSession }))),
        retention && h('div', { className: 'dcj-retention' }, t('runs.retention', { count: retention })))
    }

    function MoreMenu({ t, busy, onRunNow }) {
      const [open, setOpen] = useState(false)
      const rootRef = useRef(null)
      const close = useCallback(() => setOpen(false), [])
      useDismiss(open, close, rootRef)
      return h('span', { className: 'dcj-menuRoot', ref: rootRef },
        h('button', {
          type: 'button', className: 'dcj-btn dcj-btnGhost dcj-iconButton', title: t('detail.more'),
          'aria-label': t('detail.more'), 'aria-haspopup': 'menu', 'aria-expanded': open,
          onClick: () => setOpen(v => !v),
        }, h(IconEllipsis, null)),
        open && h('div', { className: 'dcj-menu', role: 'menu' },
          h('button', {
            type: 'button', role: 'menuitem', className: 'dcj-menuItem', disabled: busy,
            title: busy ? t('detail.runBusy') : undefined, autoFocus: true,
            onClick: () => { setOpen(false); onRunNow() },
          }, h(IconPlay, null), t(busy ? 'detail.runBusy' : 'detail.runNow'))))
    }

    function Detail({ job, call, t, locale, now, historyRecords, onClose, onChanged, onOpenSession }) {
      const [tab, setTab] = useState('settings')
      const [runs, setRuns] = useState(undefined)
      const [runsError, setRunsError] = useState(false)
      const [failure, setFailure] = useState(null)
      const [notice, setNotice] = useState(null)
      const [pending, setPending] = useState(false)
      const name = job.name
      const lastKey = job.lastRun ? `${job.lastRun.id}:${job.lastRun.status}` : ''

      const loadRuns = useCallback(async () => {
        const result = await call('runs', { name })
        if (result.ok) {
          setRuns(result.value.runs)
          setRunsError(false)
        } else {
          setRunsError(true)
        }
      }, [call, name])

      useEffect(() => { setRuns(undefined); setFailure(null); setNotice(null) }, [name])
      // Reload the runs whenever the job's latest run changes.
      useEffect(() => { loadRuns() }, [loadRuns, lastKey])

      const togglePause = async () => {
        setPending(true)
        setFailure(null)
        const result = await call('pause', { name, paused: !job.paused })
        setPending(false)
        if (!result.ok) setFailure(t('detail.pauseError', { message: errorMessage(result, '') }))
        onChanged()
      }
      const runNow = async () => {
        setFailure(null)
        setNotice(null)
        const result = await call('run', { name })
        if (result.ok) setNotice(t('detail.started'))
        else setFailure(t('detail.runError', { message: errorMessage(result, '') }))
        onChanged()
      }

      const pauseBlocked = OFF.has(job.state)
      const pauseLabel = pauseBlocked ? t('detail.pauseUnavailable') : t(job.paused ? 'detail.resume' : 'detail.pause')
      const latestSession = (runs ?? []).find(run => run.sessionId)?.sessionId ?? (job.lastRun?.sessionId || null)

      const notices = []
      if (job.state === 'disabled') notices.push(t('notice.disabled'))
      if (job.state === 'invalid') notices.push(t('notice.invalid', { error: job.error }))
      if (job.state === 'paused') {
        notices.push(job.pausedAt ? t('notice.paused', { time: formatAbsolute(job.pausedAt, locale) }) : t('notice.pausedNoTime'))
      }
      if (job.running) {
        notices.push(t('notice.running', { time: formatAbsolute(job.running.startedAt, locale), trigger: t(`trigger.${job.running.trigger}`) }))
      }

      return h('section', {
        className: 'dcj-detail',
        'aria-label': name,
        onKeyDown: (event) => {
          if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); onClose() }
        },
      },
      h('div', { className: 'dcj-detailTabsBar' },
        h('div', { className: 'dcj-detailTabs', role: 'tablist', 'aria-label': t('detail.tabs') },
          ['settings', 'runs'].map(value => h('button', {
            key: value, type: 'button', role: 'tab', className: 'dcj-detailTab',
            'aria-selected': tab === value, onClick: () => setTab(value),
          }, t(`detail.${value}`)))),
        h('div', { className: 'dcj-detailActions' },
          h('span', { title: pauseLabel }, h('button', {
            type: 'button', className: 'dcj-btn dcj-btnGhost dcj-iconButton', 'aria-label': pauseLabel,
            disabled: pauseBlocked || pending, onClick: togglePause,
          }, h(job.paused ? IconPlay : IconPause, null))),
          h(MoreMenu, { t, busy: Boolean(job.running), onRunNow: runNow }),
          h('button', {
            type: 'button', className: 'dcj-btn dcj-btnGhost dcj-iconButton', title: t('detail.close'),
            'aria-label': t('detail.close'), onClick: onClose,
          }, h(IconClose, null)))),
      h('div', { className: 'dcj-detailScroll' },
        h('div', { className: 'dcj-detailHeader' }, h('h2', { className: 'dcj-readonlyName' }, name)),
        h('div', { className: 'dcj-nextRun' }, job.nextRunAt
          ? h('p', null, t('detail.nextRun'), h('time', { dateTime: job.nextRunAt }, formatAbsolute(job.nextRunAt, locale)), ' ', formatRelative(job.nextRunAt, locale, now))
          : h('p', null, t('detail.noNextRun'))),
        notices.map((text, i) => h('p', { key: i, className: 'dcj-detailNotice' }, text)),
        notice && h('p', { className: 'dcj-detailNotice', role: 'status' }, notice),
        failure && h('p', { className: 'dcj-failure', role: 'alert' }, failure),
        tab === 'settings'
          ? h(Settings, { job, t })
          : h(Runs, { runs, error: runsError, retention: historyRecords, t, locale, onOpenSession, onRetry: loadRuns })),
      job.gated && h('div', { className: 'dcj-footer' },
        latestSession
          ? h(React.Fragment, null,
            h('span', { className: 'dcj-footerEmpty' }, t('footer.latestSession')),
            h('button', {
              type: 'button', className: 'dcj-btn dcj-btnGhost dcj-footerLink',
              onClick: () => onOpenSession(latestSession),
            }, latestSession, h(IconChevronRight, { size: 14 })))
          : h('span', { className: 'dcj-footerEmpty' }, t('footer.noSession'))))
    }

    function CronTasksPage(props) {
      const { call, openSession } = props
      const t = typeof props.t === 'function' ? props.t : props.translate
      const locale = t('time.locale')
      const [data, setData] = useState(undefined)
      const [error, setError] = useState(null)
      const [filter, setFilter] = useState('all')
      const [search, setSearch] = useState('')
      const [selected, setSelected] = useState(null)
      const [now, setNow] = useState(() => Date.now())
      const generation = useRef(0)

      const refresh = useCallback(async () => {
        const mine = ++generation.current
        const result = await call('list', {})
        if (mine !== generation.current) return
        setNow(Date.now())
        if (result.ok) {
          setData(result.value)
          setError(null)
        } else {
          setError(errorMessage(result, t('load.error')))
        }
      }, [call, t])

      useEffect(() => {
        refresh()
        const timer = setInterval(() => {
          if (document.visibilityState === 'visible') refresh()
        }, POLL_MS)
        const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          generation.current++
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [refresh])

      const jobs = data?.jobs ?? []
      const rows = useMemo(() => {
        const query = search.trim().toLowerCase()
        return jobs.filter(job => stateMatches(job, filter) && (query === ''
          || job.name.toLowerCase().includes(query) || job.command.toLowerCase().includes(query)))
      }, [jobs, filter, search])
      const selectedJob = selected === null ? undefined : jobs.find(job => job.name === selected)

      useEffect(() => {
        if (data !== undefined && selected !== null && selectedJob === undefined) setSelected(null)
      }, [data, selected, selectedJob])

      const emptyTitle = jobs.length === 0 ? 'list.empty' : search.trim() !== '' ? 'list.noMatches' : 'list.emptyFilter'

      return h('section', {
        className: cx('dcj-page', selectedJob && 'dcj-hasDetails'),
        'aria-label': t('title'),
      },
      h('div', { className: 'dcj-listPane' },
        h('div', { className: 'dcj-pageScroll' },
          h('div', { className: 'dcj-pageContent' },
            h('div', { className: 'dcj-pageHeading' },
              h('h1', { tabIndex: -1 }, t('title')),
              h('span', { className: 'dcj-headingNote' }, t('heading.note'))),
            h('div', { className: 'dcj-filters', role: 'group', 'aria-label': t('filter.label') },
              ['all', 'active', 'paused', 'off'].map(value => h('button', {
                key: value, type: 'button',
                className: cx('dcj-filterTab', filter === value && 'dcj-filterTabActive'),
                'aria-pressed': filter === value,
                onClick: () => setFilter(value),
              }, t(`filter.${value}`)))),
            h('div', { className: 'dcj-searchTools' },
              h('label', { className: 'dcj-searchField' },
                h(IconSearch, null),
                h('input', {
                  type: 'search', 'aria-label': t('search.label'), placeholder: t('search.placeholder'),
                  value: search, onChange: event => setSearch(event.target.value),
                }),
                search !== '' && h('button', {
                  type: 'button', className: 'dcj-btn dcj-btnGhost dcj-iconButton', 'aria-label': t('search.clear'),
                  onClick: () => setSearch(''),
                }, h(IconClose, { size: 14 })))),
            error && h(Notice, {
              action: h('button', { type: 'button', className: 'dcj-btn dcj-btnSm dcj-btnOutline', onClick: refresh }, t('load.retry')),
            }, error),
            data && data.historyDurable === false && h(Notice, null, t('notice.memory')),
            data === undefined && !error && h('p', { className: 'dcj-detailNotice' }, t('load.loading')),
            data !== undefined && rows.length === 0 && h('div', { className: 'dcj-empty', role: 'status' },
              h(IconAlarmClock, { size: 40 }),
              h('h2', null, t(emptyTitle))),
            h('ul', { className: 'dcj-listRows', 'aria-label': t('list.label'), 'aria-busy': data === undefined },
              rows.map(job => h(ListRow, {
                key: job.name, job, t, locale, now,
                selected: job.name === selected,
                onSelect: () => setSelected(job.name),
              })))))),
      selectedJob && h(Detail, {
        key: selectedJob.name,
        job: selectedJob, call, t, locale, now,
        historyRecords: data?.historyRecords,
        onClose: () => setSelected(null),
        onChanged: refresh,
        onOpenSession: openSession,
      }))
    }

    // ---------------------------------------------------------------- plugin

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const disposers = [ctx.locale.register(NS, 'en', en), ctx.locale.register(NS, 'zh', zh)]
          return () => { for (const dispose of disposers) dispose() }
        }, 'cron-jobs: dictionaries')
        const t = ctx.locale.bind(NS)

        ctx.effect(() => {
          if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return () => {}
          const tag = document.createElement('style')
          tag.id = STYLE_ID
          tag.dataset.plugin = 'dsh-cron-jobs'
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => tag.remove()
        }, 'cron-jobs: styles')

        /** One call to the Host half; a carrier failure becomes an error result. */
        const call = async (endpoint, payload) => {
          try {
            const response = await fetch(API_BASE + endpoint, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload ?? {}),
            })
            const type = response.headers.get('content-type') ?? ''
            if (!type.includes('application/json')) throw new Error(`HTTP ${response.status} for ${endpoint}`)
            return await response.json()
          } catch (error) {
            return { ok: false, error: { code: 'transport', message: error instanceof Error ? error.message : String(error) } }
          }
        }
        const openSession = (id) => {
          const workspace = ctx.get('uiWorkspace')
          if (workspace !== undefined) workspace.openSession(id)
        }

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL,
          locale: NS,
          inject: () => ({ call, openSession, translate: t }),
        }, CronTasksPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL,
          order: 11,
          locale: NS,
          label: () => t('panel'),
        }, SidebarIcon))
      },
    }
  },
})
