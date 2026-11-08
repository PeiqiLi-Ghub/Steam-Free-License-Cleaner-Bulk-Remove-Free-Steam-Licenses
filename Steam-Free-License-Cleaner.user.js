// ==UserScript==
// @name         Steam-Free-License-Cleaner-Bulk-Remove-Free-Steam-Licenses
// @name:zh-CN   Steam 免费游戏批量删除 / 一键清库存脚本
// @namespace    https://github.com/LunaLi-hub/Steam-Free-License-Cleaner-Bulk-Remove-Free-Steam-Licenses
// @version      4.0
// @description  Unified filter toolbar (search / category / acquisition method / date range) on every tab, works before and during cleaning. Select-all / invert / clear act on the filtered list; add checked to skip / move back out of skip. Delay stays at the base value unless error 84 (rate limit) happens. v3.1: paginated list with page jump and page-size selector (pure local view, never resets cleaning).
// @description:zh-CN  统一筛选工具栏（搜索/分类/获取方式/日期区间），所有页签在清理前后均可筛选；全选/反选/清空作用于筛选结果；勾选项可加入跳过/移出跳过。只有触发错误84才会降速，否则保持基础间隔。v3.1：列表支持翻页、页码跳转和每页条数选择（纯本地视图，翻页不会重置清理）。
// @author       luna
// @match        https://store.steampowered.com/account/licenses/*
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const CFG = {
        delaySec: 2,
        coolMin: 5, coolStepMin: 1, coolMaxMin: 20, coolMaxLimit: 180,
        coolJitter: 0.1, coolDecayAfter: 20, coolKeepMs: 3600000,
        gapFirst: 3000, gapGrowth: 1.5, gapMax: 60000, gapDecayAfter: 25, gapDecay: 0.85,
        failDelay: [3000, 6000], breakerAfter: 4, maxAttempts: 3,
        retryPassWait: 30000, netRetryDelay: [5000, 10000],
        pageFetchDelay: [800, 1800], maxPages: 3000
    };

    const FREE_WEEKEND_RE = /free\s*weekend|免费周末|免費週末/i;

    const CAT_DEFS = [
        { id: 'demo', res: [
            /\bdemo\b/i, /\btrial\b/i, /\bbeta\b/i, /\bplaytest\b/i, /\bpreview\b/i,
            /\bprologue\b/i, /\bprolog\b/i,
            /试[玩用]/, /体验版?|體驗版?/, /序章/, /测试版?|測試版?/, /预览版?|預覽版?/,
            /体験版?/, /お試し/, /체험판/, /데모/, /프롤로그/,
            /демо/i, /пробн/i, /пролог/i, /demostración/i, /démo/i,
            /\btrailers?\b/i, /预告片?|預告片?/, /予告編?/, /트레일러/, /трейлер/i, /\btráiler\b/i, /\bbande-annonce\b/i
        ]},
        { id: 'soundtrack', res: [
            /\bsoundtrack\b/i, /\bsound\s+track\b/i, /\bost\b/i,
            /\boriginal\s+(?:game\s+)?soundtrack\b/i,
            /原声带?|原聲帶?/, /音乐包|音樂包/, /音轨|音軌/, /配乐|配樂/, /音乐集|音樂集/,
            /サウンドトラック/, /サントラ/, /사운드트랙/, /오리지널\s*사운드/,
            /саундтрек/i, /партитура/i, /banda\s+sonora/i, /colonna\s+sonora/i
        ]},
        { id: 'dlc', res: [
            /\bdlc\b/i, /\badd-?on\b/i, /\bexpansion\b/i, /\bseason\s+pass\b/i,
            /\bbundle\b/i, /\bpack\b/i,
            /扩展包?|擴展包?|资料片|資料片|追加内容|追加內容|季票/,
            /拡張パック?/, /追加コンテンツ/, /シーズンパス/,
            /확장팩/, /추가\s*콘텐츠/, /시즌\s*패스/,
            /дополнени/i, /сезонный\s+пропуск/i,
            /\bexpansión\b/i, /\bpase\s+de\s+temporada\b/i
        ]},
        { id: 'tool', res: [
            /\bdedicated\s+server\b/i, /\bsdk\b/i, /\btool\b/i, /\bworkshop\b/i, /\bmod\s+tool\b/i,
            /工具/, /服务器|伺服器/, /专用服务器|專用伺服器/,
            /ツール/, /サーバー/, /도구/, /서버/,
            /инструмент/i, /сервер/i, /herramienta/i, /servidor/i
        ]}
    ];

    function categorize(name) {
        const cats = [];
        for (const c of CAT_DEFS) if (c.res.some(re => re.test(name))) cats.push(c.id);
        if (!cats.length) cats.push('game');
        return cats;
    }

    function parseDate(s) {
        if (!s) return null;
        let m = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})/);
        if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
        m = s.match(/(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
        if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
        const v = Date.parse(s);
        return isNaN(v) ? null : v;
    }

    const I18N = {
        en: {
            title: 'License Cleaner',
            riskBanner: '⚠ Deletion cannot be undone. Most games can be re-added, but if a game is delisted or no longer sold in your region after removal, it may never be recoverable; games switched to paid must be repurchased.',
            stat_removed: 'Removed (total)', stat_skipped: 'Skipped (error 29)',
            stat_retry: 'To retry', stat_perm: 'Not removable', stat_remain: 'Remaining',
            notStarted: 'Not started',
            btn_start: 'Start cleaning', btn_scan: 'Scan list only', btn_stop: 'Stop', btn_reset: 'Reset records',
            btn_clearCool: 'Clear cooldown', btn_restoreSkip: 'Restore all records',
            btn_clearLog: 'Clear log',
            tip_scan: 'Read every page and list the removable items without deleting anything',
            tip_reset: 'Clear the skipped list, totals, deleted list and cooldown state',
            tip_restoreSkip: 'Restore everything backed up when you last reset records',
            tip_clearLog: 'Empty the log panel (records, totals and lists are not affected)',
            confirmReset: 'Reset all records?\n\nThis clears the skipped list, totals, deleted list and cooldown state. Everything is backed up first.',
            confirmCount: n => `${n} checked item(s) will be removed.\n\n`,
            noScanTitle: 'List not scanned',
            noScanBody: 'Cleaning now removes every item not on the skipped list, and it cannot be undone.',
            noScanGo: 'I understand the risk, clean now', noScanScan: 'Scan first',
            confirmDelete: 'This cannot be undone. You may accidentally remove a game you want to keep.\n\nMost games can be re-added by searching the Steam store, but delisted games cannot be re-added.',
            set_delay_pre: 'Base delay', set_delay_post: 'sec',
            set_cool_pre: 'First cooldown', set_cool_post: 'min (+1 each)',
            set_coolmax_pre: 'Max cooldown', set_coolmax_post: 'min',
            tab_log: 'Log', tab_pending: 'Pending', tab_perm: 'Not removable',
            tab_deleted: 'Deleted', tab_skipped: 'Skipped', tab_failed: 'Failed',
            filterPh: 'Search name or ID',
            b_idle: 'Idle', b_run: 'Running', b_cool: 'Cooling down', b_done: 'Done',
            b_scanned: 'Scan done', b_stopped: 'Stopped', b_scanning: 'Scanning',
            curScanning: (p, n) => `Scanning pages (${p} read, ${n} found)`,
            curPreparing: 'Preparing queue (reading the first batch)',
            curProcessing: n => `Processing: ${n}`,
            curScanDone: n => `Scan complete, ${n} pending`,
            curAllDone: 'All done', curStopped: 'Stopped',
            eta: (dur, at) => `About ${dur} left, done around ${at}`,
            etaReading: ' (still reading pages)',
            coolBar: (c, l, r) => `Rate-limit cooldown, <b>${c}</b> left · level ${l}` + (r ? ' — no delete requests are sent during cooldown' : ' — it will wait for the cooldown to end after you press Start'),
            unitMin: 'min', unitHour: 'h', unitDay: 'd',
            unknownName: 'Unknown item', nameMissing: '(name not recorded)',
            processing: 'Processing', queuePos: i => `Queue #${i}`, tailPos: i => `Last batch #${i}`,
            retryExtra: (a, m, e) => `To retry · failed ${a}/${m} · ${e}`,
            gaveExtra: e => `Given up · ${e}`,
            emptyPending: 'Nothing yet. Press "Scan list only" or "Start cleaning" to read the removable items.',
            emptyDeleted: 'No deletion records yet (only items deleted since v5.1 are recorded).',
            emptySkipped: 'No skipped items.', emptyFailed: 'No failed items.',
            emptyPerm: 'Nothing yet. Press "Scan list only" to read the full license list; items without a remove button (purchased products, time-limited licenses) will be listed here.',
            noFilterMatch: 'No items match the current filter.',
            more: (n, c) => `${n} items, showing the first ${c}. Use the filter bar to narrow it down.`,
            errCode: c => `Error ${c}`,
            resetDone: 'Records reset', coolCleared: 'Cooldown cleared',
            restoreDone: (a, n, r, d) => `Restored all records: ${a} skipped items added (${n} on record), removed total +${r}, ${d} deleted-list entries`,
            restoreEmpty: 'No backup to restore',
            startLog: (r, s) => `Started (total removed ${r}, skipped on record ${s})`,
            startLogChecked: n => `Started with ${n} checked items`,
            stillCooling: c => `Still inside the previous cooldown, ${c} left. Waiting first.`,
            logWait: (l, s) => `${l}, about ${s}s`,
            pageHttp: s => `Page read: HTTP ${s}, retrying shortly`,
            pageErr: m => `Page read failed: ${m}, retrying shortly`,
            readProg: (p, n) => `Read up to page ${p}, ${n} removable found so far`,
            readDone: (p, n) => `Finished reading ${p} pages, ${n} removable found`,
            reason84: 'Error 84: rate limited',
            reasonBreaker: (n, e) => `${n} failures in a row (${e}), probably rate limited`,
            coolLog: (r, ok, d, l, g) => `${r} (${ok} successes before this). Cooling down ${d} (level ${l}, +1 min per level); extra delay per deletion is now ${g}s`,
            okLog: (n, id) => `✓ ${n} (${id}) deleted`,
            skipLog: (n, id) => `- ${n} (${id}) error 29, skipped for good`,
            err24: 'Error 24: login session expired. Refresh the page or sign in again, then press Start.',
            deferLog: (n, id, e, a, m) => `! ${n} (${id}) ${e}. Skipping for now, will retry at the end (failure ${a}/${m})`,
            gaveLog: (n, id, a, e) => `✕ Giving up on ${n} (${id}): failed ${a} times, last error ${e}`,
            retryStart: (n, p) => `Retrying ${n} earlier failures (pass ${p})`,
            retryWaitLabel: 'Waiting a moment before retrying',
            rescan: r => `Round ${r}: re-reading all pages to check for leftovers`,
            scriptErr: m => `Script error: ${m}`,
            finishLog: (done, r, s, g, t) => `${done ? 'Finished' : 'Stopped'}: removed ${r}, skipped ${s}, gave up ${g} this run; ${t} removed in total`,
            gaveList: (names, more) => `Given up (press Start later to try again): ${names}${more ? ' …' : ''}`,
            stopReq: 'Stop requested; will stop after the current step',
            scanStart: 'Scanning all pages (nothing will be deleted)',
            scanDone: n => `Scan complete: ${n} removable items. See the Pending tab.`,
            scanStopped: 'Scan stopped', scanErr: m => `Scan error: ${m}`,
            scanSwitched: 'Switched to "Pending" tab — filter, check items, then press "Start cleaning".',
            cat_demo: 'Demo/Trailer', cat_soundtrack: 'Soundtrack', cat_dlc: 'DLC', cat_tool: 'Tool', cat_game: 'Game', cat_risk29: 'May not be removable', tip_risk29: 'Steam may refuse to remove these (for example Free Weekend items, or items whose acquisition method was refused before). If Steam refuses, the item is skipped automatically and never retried. You can also add them to the skipped list yourself.',
            sel_info: n => `${n} checked`,
            sel_hidden: h => ` (${h} hidden by filter)`,
            sel_all: 'Select all', sel_inv: 'Invert', sel_none: 'Clear',
            tip_selAll: 'Check every item currently shown (after filtering, across all pages)',
            tip_selInv: 'Invert the check state of the items currently shown (after filtering, across all pages)',
            tip_selNone: 'Uncheck the items currently shown (after filtering, across all pages)',
            noSelection: 'Nothing selected — pick at least one item.',
            q_label: 'Quick clean:',
            q_demo: 'Only Demo/Trailer', q_soundtrack: 'Only Soundtrack', q_dlc: 'Only DLC', q_tool: 'Only Tool',
            quickScanning: 'Quick clean: scanning first...',
            quickNoItems: 'Quick clean: no removable items found.',
            quickNone: c => `Quick clean: no "${c}" items.`,
            quickStart: (n, c) => `Quick clean: starting with ${n} "${c}" item(s).`,
            riskHint: n => `Hint: ${n} item(s) were tagged "May not be removable" (Free Weekend names, or acquisition methods that Steam mostly refused before). Click that tag to review them; you can add them to skip.`,
            sel_skip: 'Add checked to skip',
            tip_skipSel: 'Add the checked items that are currently shown to the skipped list so they are never deleted',
            skipSelNone: 'Add to skip: none of the items shown is checked.',
            skipSelDone: (n, total) => `Added ${n} checked item(s) to the skipped list (${total} on record).`,
            showAll: n => `Show all ${n}`, showLess: c => `Show first ${c} only`,
            sel_unskip: 'Move checked out of skip',
            tip_unskipSel: 'Remove the checked items that are currently shown from the skipped list and put them back into pending',
            unskipNone: 'Move out of skip: none of the items shown is checked.',
            unskipDone: (n, total) => `Moved ${n} item(s) out of the skipped list into pending (${total} pending in total).`,
            unskipScanning: n => `Removed ${n} item(s) from the skipped list. Scanning to rebuild the pending list...`,
            usingScan: n => `Using the earlier scan result (${n} items), no need to re-read the pages`,
            f_method: 'Acquired via', f_anyMethod: 'Filter by acquisition method',
            f_from: 'From', f_to: 'To',
            f_clear: 'Clear filter',
            notScanned: 'Not scanned yet — press "Scan list only" first.',
            fInfo: (a, b) => `Showing ${a} / ${b}`,
            pg_page: (p, n, total) => `Page ${p} / ${n} (${total} items)`,
            pg_size: n => `${n} / page`,
            pg_jump: 'Go to page',
            nat_page: (p, n) => `Page ${p} / ${n}`, nat_go: 'Go',
            nat_loading: 'Loading pages…',
            nat_cacheonly: 'Scan/cleaning in progress: only pages already read can be opened.',
            nat_wait: 'Please press "Scan list only" first to read all pages.',
            nat_scanfirst: 'Please press "Scan list only" first to read all pages.',
            nat_err: 'Could not load that page. Try again later.',
            nat_scanhint: 'Press "Scan list only" first; paging works once the scan finishes.',
            nat_ready: 'Press "Scan list only" first; paging works once the scan finishes.',
            nat_single: 'No next-page link found: only one page, or the page layout differs.',
            nat_notable: 'Original license table not found; page turner disabled.'
        },
        zh: {
            title: '库存清理器',
            riskBanner: '⚠ 删除不可逆：多数游戏可从商店重新添加，但删除后若游戏下架、在你所在地区停售，可能再也无法入库；转为付费的则需重新购买才能入库。',
            stat_removed: '已删除（累计）', stat_skipped: '已跳过（错误29）',
            stat_retry: '待重试', stat_perm: '不可移除', stat_remain: '本轮剩余',
            notStarted: '尚未开始',
            btn_start: '开始清理', btn_scan: '仅扫描列表', btn_stop: '停止', btn_reset: '重置记录',
            btn_clearCool: '清除冷却', btn_restoreSkip: '恢复全部记录',
            btn_clearLog: '清理日志',
            tip_scan: '只读取所有分页并列出待删除项目，不执行删除',
            tip_reset: '清除已跳过列表、累计计数、已删除列表和冷却状态',
            tip_restoreSkip: '恢复上次重置记录时备份的全部内容',
            tip_clearLog: '清空日志面板（不影响记录、计数和各列表）',
            confirmReset: '确定要重置所有记录吗？\n\n将清除已跳过列表、累计计数、已删除列表和冷却状态。所有记录会先备份。',
            confirmCount: n => `将删除已勾选的 ${n} 个项目。\n\n`,
            noScanTitle: '尚未扫描列表',
            noScanBody: '直接清理会删除所有未加入跳过列表的项目，且不可恢复。',
            noScanGo: '知晓风险，确认清理', noScanScan: '先去扫描',
            confirmDelete: '此操作不可逆，可能误删想保留的游戏。\n\n大部分游戏可在商店搜索重新添加，但已下架的游戏无法重新入库。',
            set_delay_pre: '基础间隔', set_delay_post: '秒',
            set_cool_pre: '首次冷却', set_cool_post: '分钟（每次+1）',
            set_coolmax_pre: '最长冷却', set_coolmax_post: '分钟',
            tab_log: '日志', tab_pending: '待删除', tab_perm: '不可移除',
            tab_deleted: '已删除', tab_skipped: '已跳过', tab_failed: '失败',
            filterPh: '搜索名称或 ID',
            b_idle: '空闲', b_run: '运行中', b_cool: '冷却中', b_done: '已完成',
            b_scanned: '扫描完成', b_stopped: '已停止', b_scanning: '扫描中',
            curScanning: (p, n) => `正在扫描分页（已读 ${p} 页，发现 ${n} 个）`,
            curPreparing: '正在准备队列（先读取前一批）',
            curProcessing: n => `正在处理：${n}`,
            curScanDone: n => `扫描完成，共 ${n} 个待删除`,
            curAllDone: '全部处理完毕', curStopped: '已停止',
            eta: (dur, at) => `预计还需 ${dur}，约 ${at} 完成`,
            etaReading: '（仍在读取分页）',
            coolBar: (c, l, r) => `限流冷却中，剩余 <b>${c}</b>　·　第 ${l} 级` + (r ? '，冷却期间不会发送任何删除请求' : '，点击开始后会先等冷却结束'),
            unitMin: '分钟', unitHour: '小时', unitDay: '天',
            unknownName: '未知游戏名', nameMissing: '（名称未记录）',
            processing: '处理中', queuePos: i => `排队第 ${i} 位`, tailPos: i => `最后批次第 ${i} 位`,
            retryExtra: (a, m, e) => `待重试 · 失败 ${a}/${m} · ${e}`,
            gaveExtra: e => `已放弃 · ${e}`,
            emptyPending: '暂无。点击"仅扫描列表"或"开始清理"来读取待删除项目',
            emptyDeleted: '还没有删除记录（只记录 v5.1 之后删除的项目）',
            emptySkipped: '没有被跳过的项目', emptyFailed: '没有失败的项目',
            emptyPerm: '暂无。点击「仅扫描列表」读取完整授权列表；没有移除按钮的项目（购买产品、限时入库内容等）会列在这里。',
            noFilterMatch: '没有符合当前筛选条件的项目。',
            more: (n, c) => `共 ${n} 条，仅显示前 ${c} 条，可用筛选栏缩小范围`,
            errCode: c => `错误${c}`,
            resetDone: '记录已重置', coolCleared: '冷却已清除',
            restoreDone: (a, n, r, d) => `已恢复全部记录：新增 ${a} 个跳过项目（当前记录 ${n} 个），累计删除数 +${r}，已删除列表 ${d} 条`,
            restoreEmpty: '没有可恢复的备份',
            startLog: (r, s) => `开始清理（累计已删 ${r}，已记录跳过 ${s}）`,
            startLogChecked: n => `开始清理，仅处理已勾选的 ${n} 个项目`,
            stillCooling: c => `仍在上次的冷却期内，剩余 ${c}，先等待`,
            logWait: (l, s) => `${l}，约 ${s} 秒`,
            pageHttp: s => `读取分页 HTTP ${s}，稍后重试`,
            pageErr: m => `读取分页出错：${m}，稍后重试`,
            readProg: (p, n) => `已读取到第 ${p} 页，累计发现可删 ${n} 个`,
            readDone: (p, n) => `分页读取结束，共 ${p} 页，发现可删 ${n} 个`,
            reason84: '错误84，触发限流',
            reasonBreaker: (n, e) => `连续失败 ${n} 次（${e}），疑似限流`,
            coolLog: (r, ok, d, l, g) => `${r}（此前连续成功 ${ok} 个）。冷却 ${d}（第 ${l} 级，每次+1分钟），之后每次删除额外间隔 ${g} 秒`,
            okLog: (n, id) => `✓ ${n}（${id}）已删除`,
            skipLog: (n, id) => `- ${n}（${id}）错误29，已永久跳过`,
            err24: '错误24：登录会话已失效，请刷新页面或重新登录后再开始',
            deferLog: (n, id, e, a, m) => `! ${n}（${id}）${e}，先跳过，最后再重试（第 ${a}/${m} 次失败）`,
            gaveLog: (n, id, a, e) => `✕ 放弃 ${n}（${id}）：失败 ${a} 次，最后一次 ${e}`,
            retryStart: (n, p) => `开始重试 ${n} 个先前失败的项目（第 ${p} 轮）`,
            retryWaitLabel: '先等一会儿再重试',
            rescan: r => `第 ${r} 轮：重新读取分页，检查有无遗漏`,
            scriptErr: m => `脚本异常：${m}`,
            finishLog: (done, r, s, g, t) => `${done ? '已完成' : '已停止'}：本次删除 ${r}，跳过 ${s}，放弃 ${g}；累计删除 ${t}`,
            gaveList: (names, more) => `放弃的项目（可稍后再点开始重试）：${names}${more ? ' ……' : ''}`,
            stopReq: '已请求停止，当前操作结束后停下',
            scanStart: '开始扫描所有分页（不会删除任何东西）',
            scanDone: n => `扫描完成：共 ${n} 个可删除项目，可在"待删除"页签查看`,
            scanStopped: '扫描已停止', scanErr: m => `扫描异常：${m}`,
            scanSwitched: '已切换到「待删除」页，筛选并勾选项目后点「开始清理」。',
            cat_demo: '试玩/预告', cat_soundtrack: '原声', cat_dlc: 'DLC', cat_tool: '工具', cat_game: '游戏', cat_risk29: '可能删不掉', tip_risk29: 'Steam 可能会拒绝删除这些项目（例如免费周末，或获取方式以往多次被拒绝）。被拒绝时脚本会自动跳过且不再重试，你也可以提前把它们加入跳过列表。',
            sel_info: n => `已勾选 ${n}`,
            sel_hidden: h => `（另有 ${h} 个被筛选隐藏）`,
            sel_all: '全选', sel_inv: '反选', sel_none: '清空',
            tip_selAll: '勾选筛选后的所有项目（含所有页）',
            tip_selInv: '反选筛选后的所有项目（含所有页）',
            tip_selNone: '取消勾选筛选后的所有项目（含所有页）',
            noSelection: '没有选中任何项目——请至少勾选一项。',
            q_label: '快捷清理：',
            q_demo: '仅删试玩/预告', q_soundtrack: '仅删原声', q_dlc: '仅删 DLC', q_tool: '仅删工具',
            quickScanning: '快捷清理：先扫描列表...',
            quickNoItems: '快捷清理：未找到可删除项目。',
            quickNone: c => `快捷清理：没有「${c}」类项目。`,
            quickStart: (n, c) => `快捷清理：开始处理「${c}」共 ${n} 项。`,
            riskHint: n => `提示：有 ${n} 个项目被标记为「可能删不掉」（免费周末，或获取方式以往多半被 Steam 拒绝）。点击该标签可集中查看，可勾选后加入跳过。`,
            sel_skip: '勾选项加入跳过',
            tip_skipSel: '将当前显示的已勾选项目加入跳过列表（永不删除）',
            skipSelNone: '加入跳过：当前显示的项目中没有勾选项。',
            skipSelDone: (n, total) => `已将勾选的 ${n} 个项目加入跳过列表（当前记录 ${total} 个）。`,
            showAll: n => `显示全部 ${n} 条`, showLess: c => `只显示前 ${c} 条`,
            sel_unskip: '勾选项移出跳过',
            tip_unskipSel: '将当前显示的已勾选项目从跳过列表移出，放回待删除列表',
            unskipNone: '移出跳过：当前显示的项目中没有勾选项。',
            unskipDone: (n, total) => `已将 ${n} 个项目移出跳过列表并放入待删除（待删除共 ${total} 个）。`,
            unskipScanning: n => `已将 ${n} 个项目移出跳过列表，正在扫描以重建待删除列表...`,
            usingScan: n => `使用之前的扫描结果（${n} 个），无需重新读取分页`,
            f_method: '获取方式', f_anyMethod: '按获取方式筛选',
            f_from: '从', f_to: '到',
            f_clear: '清除筛选',
            notScanned: '尚未扫描——请先点击「仅扫描列表」。',
            fInfo: (a, b) => `显示 ${a} / ${b}`,
            pg_page: (p, n, total) => `第 ${p} / ${n} 页（共 ${total} 条）`,
            pg_size: n => `每页 ${n} 条`,
            pg_jump: '跳转到页',
            nat_page: (p, n) => `第 ${p} / ${n} 页`, nat_go: '跳转',
            nat_loading: '正在加载分页…',
            nat_cacheonly: '正在扫描/清理：只能翻已经读取完的页面。',
            nat_wait: '请先点「仅扫描列表」读取所有页，之后才能翻页。',
            nat_scanfirst: '请先点「仅扫描列表」读取所有页，之后才能翻页。',
            nat_err: '该页加载失败，请稍后再试。',
            nat_scanhint: '请先点「仅扫描列表」，扫描完成后即可翻页。',
            nat_ready: '请先点「仅扫描列表」，扫描完成后即可翻页。',
            nat_single: '没找到下一页链接：只有一页，或页面结构不同。',
            nat_notable: '没找到原授权表格，翻页功能已停用。'
        }
    };

    const STORE_KEY = 'steamLicenseCleanerState';
    const DEFAULTS = {
        skipped: [], removed: 0, minGap: 0,
        coolLevel: 0, cooldownUntil: 0, lastCoolAt: 0,
        delaySec: CFG.delaySec, coolMin: CFG.coolMin, coolMaxMin: CFG.coolMaxMin,
        skippedInfo: {}, skippedMeta: {}, lang: 'en', pageSize: 50
    };
    function loadState() {
        try {
            const s = JSON.parse(localStorage.getItem(STORE_KEY));
            if (s) return Object.assign({}, DEFAULTS, s);
        } catch (e) {}
        return Object.assign({}, DEFAULTS);
    }
    function saveState() {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
    }
    const state = loadState();
    if (typeof state.coolMin !== 'number' || !(state.coolMin >= 1)) state.coolMin = CFG.coolMin;
    if (typeof state.coolMaxMin !== 'number' || !(state.coolMaxMin >= 1)) state.coolMaxMin = CFG.coolMaxMin;
    if (state.coolMaxMin > CFG.coolMaxLimit) state.coolMaxMin = CFG.coolMaxLimit;
    if (state.coolMin > state.coolMaxMin) state.coolMin = state.coolMaxMin;
    if (![20, 50, 100, 200, 500].includes(Number(state.pageSize))) state.pageSize = 50;
    state.pageSize = Number(state.pageSize);
    const skipSet = new Set(state.skipped);
    if (!state.skippedInfo || typeof state.skippedInfo !== 'object') state.skippedInfo = {};
    if (!state.skippedMeta || typeof state.skippedMeta !== 'object') state.skippedMeta = {};
    if (!I18N[state.lang]) state.lang = 'en';
    // The extra per-deletion gap is only a within-run reaction to error 84.
    // It must never carry over from an earlier run / page load.
    state.minGap = 0;
    // The cooldown escalation level decays with time: it is kept only if the last cooldown was
    // less than CFG.coolKeepMs ago, otherwise the next one starts again at the configured first cooldown.
    function decayCoolLevel() {
        if (state.coolLevel > 0 && Date.now() - (Number(state.lastCoolAt) || 0) > CFG.coolKeepMs) state.coolLevel = 0;
    }
    decayCoolLevel();

    const t = (k, ...a) => {
        const v = (I18N[state.lang] && I18N[state.lang][k] !== undefined) ? I18N[state.lang][k] : I18N.en[k];
        return typeof v === 'function' ? v(...a) : v;
    };

    const DEL_KEY = 'steamLicenseCleanerDeleted';
    const DEL_MAX = 20000;
    let deletedList = [];
    try { deletedList = JSON.parse(localStorage.getItem(DEL_KEY)) || []; } catch (e) {}
    let delTimer = null;
    function saveDeleted() {
        if (delTimer) { clearTimeout(delTimer); delTimer = null; }
        try { localStorage.setItem(DEL_KEY, JSON.stringify(deletedList)); } catch (e) {}
    }
    // entry: [packageId, name, deletedAt, method, acquiredDate(ts|null), acquiredDateText]
    function recordDeleted(g) {
        deletedList.push([g.packageId, g.itemName, Date.now(), g.method || '', g.date == null ? null : g.date, g.dateText || '']);
        if (deletedList.length > DEL_MAX) deletedList.splice(0, deletedList.length - DEL_MAX);
        if (!delTimer) delTimer = setTimeout(saveDeleted, 3000);
    }

    // x: 1 = Steam really answered error 29 for this item (used to learn which kinds of items tend to be 29).
    function skipMeta(g, from29) {
        return { m: g.method || '', d: g.date == null ? null : g.date, t: g.dateText || '', x: from29 ? 1 : 0 };
    }
    function addToSkipped(g, from29) {
        if (!skipSet.has(g.packageId)) { skipSet.add(g.packageId); state.skipped.push(g.packageId); }
        state.skippedInfo[g.packageId] = g.itemName;
        state.skippedMeta[g.packageId] = skipMeta(g, from29);
    }

    // "Likely 29" hint, learned from this browser's own history:
    //  - acquisition methods where at least half of the past outcomes were a real error 29 (min. 2 cases)
    //  - names that look like a Free Weekend
    function methodStats() {
        const st = new Map();
        const bump = (m, k) => { if (!m) return; const o = st.get(m) || { s: 0, d: 0 }; o[k]++; st.set(m, o); };
        for (const id of state.skipped) {
            const m = state.skippedMeta[id];
            if (m && m.x) bump(m.m, 's');
        }
        for (const e of deletedList) bump(e[3], 'd');
        return st;
    }
    function markRisk(list) {
        const st = methodStats();
        let n = 0;
        for (const g of list) {
            g.cats = (g.cats || categorize(g.itemName)).filter(c => c !== 'risk29');
            const o = g.method ? st.get(g.method) : null;
            const byMethod = !!o && o.s >= 2 && o.s / (o.s + o.d) >= 0.5;
            if (byMethod || FREE_WEEKEND_RE.test(g.itemName)) { g.cats.unshift('risk29'); n++; }
        }
        return n;
    }

    const SKIP_BACKUP_KEY = 'steamLicenseCleanerSkippedBackup';
    function loadSkipBackup() {
        try {
            const b = JSON.parse(localStorage.getItem(SKIP_BACKUP_KEY));
            if (b && Array.isArray(b.skipped)) return b;
        } catch (e) {}
        return null;
    }
    let skipBackup = loadSkipBackup();

    const run = {
        running: false, scanning: false, last: '', ctl: null, current: '',
        queue: [], cur: null, tail: [], preparing: false,
        retry: new Map(), gaveUp: new Map(),
        processed: 0, removedRun: 0, skippedRun: 0,
        startAt: 0, okStreak: 0, sinceLimit: 0, failStreak: [],
        wake: null, lockRelease: null,
        scanList: [], nonRemovableList: [], nonRemovableSeen: new Set(),
        allowedSet: null
    };

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const rand = ([min, max]) => Math.round(min + Math.random() * (max - min));
    const pad2 = n => String(n).padStart(2, '0');
    const fmtClock = ms => {
        const s = Math.ceil(ms / 1000);
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        return h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${pad2(m)}:${pad2(sec)}`;
    };
    const fmtDhm = ms => {
        const total = Math.max(1, Math.ceil(ms / 60000));
        const d = Math.floor(total / 1440), h = Math.floor((total % 1440) / 60), m = total % 60;
        const parts = [];
        if (d) parts.push(`${d}${t('unitDay')}`);
        if (d || h) parts.push(`${h}${t('unitHour')}`);
        parts.push(`${m}${t('unitMin')}`);
        return parts.join(' ');
    };
    const fmtAt = ms => {
        const d = new Date(Date.now() + ms);
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    };

    let els = null;
    const origTitle = document.title;

    const CSS = `
    #slc{margin:14px 0 22px;border-radius:3px;background:linear-gradient(135deg,rgba(22,32,45,.96),rgba(27,40,56,.96));border:1px solid rgba(102,192,244,.18);box-shadow:0 0 14px rgba(0,0,0,.55);color:#c6d4df;font-family:"Motiva Sans",Arial,Helvetica,sans-serif;font-size:13px;overflow:hidden}
    #slc *{box-sizing:border-box}
    #slc [hidden]{display:none !important}
    #slc .slc-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:linear-gradient(to right,rgba(62,103,150,.38),rgba(0,0,0,0) 80%);border-bottom:1px solid rgba(0,0,0,.35)}
    #slc .slc-title{display:flex;align-items:center;gap:9px;font-size:16px;color:#fff;letter-spacing:.03em}
    #slc .slc-title svg{width:18px;height:18px;fill:#67c1f5}
    #slc .slc-title em{font-style:normal;font-size:11px;color:#56707f;letter-spacing:0}
    #slc .slc-headr{display:flex;align-items:center;gap:10px}
    #slc .slc-lang{border:1px solid rgba(103,193,245,.35);background:none;color:#67c1f5;border-radius:2px;padding:1px 9px;font-size:12px;cursor:pointer;font-family:inherit}
    #slc .slc-lang:hover{background:rgba(103,193,245,.2);color:#fff}
    #slc .slc-badge{padding:2px 11px;border-radius:2px;font-size:12px;background:rgba(103,193,245,.15);color:#67c1f5}
    #slc .slc-badge.run{background:rgba(164,208,7,.16);color:#a4d007}
    #slc .slc-badge.cool{background:rgba(255,200,44,.16);color:#ffc82c}
    #slc .slc-badge.done{background:rgba(164,208,7,.16);color:#a4d007}
    #slc .slc-risk{display:flex;align-items:flex-start;gap:8px;padding:9px 16px;background:rgba(224,96,94,.08);border-left:3px solid #e0605e;color:#e8a09e;font-size:12px;line-height:1.5}
    #slc .slc-stats{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:rgba(0,0,0,.3)}
    #slc .slc-stat{background:rgba(10,18,28,.55);padding:12px 16px}
    #slc .slc-stat b{display:block;font-size:24px;font-weight:300;color:#fff;line-height:1.2}
    #slc .slc-stat span{font-size:11px;color:#8f98a0;letter-spacing:.04em}
    #slc .slc-prog{padding:14px 16px 4px}
    #slc .slc-bar{height:6px;border-radius:3px;background:rgba(0,0,0,.45);overflow:hidden}
    #slc .slc-bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#1a9fff,#67c1f5);transition:width .4s}
    #slc .slc-meta{display:flex;justify-content:space-between;gap:12px;margin-top:7px;font-size:12px;color:#8f98a0}
    #slc .slc-meta span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #slc .slc-meta span:last-child{flex-shrink:0;max-width:60%;text-align:right;white-space:normal;font-variant-numeric:tabular-nums}
    #slc .slc-cool{margin:10px 16px 0;padding:8px 12px;background:rgba(255,200,44,.08);border-left:3px solid #ffc82c;color:#ffc82c;font-size:12px}
    #slc .slc-cool b{font-weight:600;font-variant-numeric:tabular-nums}
    #slc .slc-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:14px 16px}
    #slc .slc-quickbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:0 16px 14px;font-size:12px}
    #slc .slc-quickbar .slc-quicklabel{color:#8f98a0;margin-right:2px}
    #slc .slc-quickbtn{border:1px solid rgba(103,193,245,.3);background:rgba(103,193,245,.08);color:#67c1f5;border-radius:2px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit;transition:filter .15s}
    #slc .slc-quickbtn:hover{background:rgba(103,193,245,.25);color:#fff}
    #slc .slc-quickbtn:disabled{opacity:.35;cursor:default}
    #slc .slc-quickbtn.q-demo{color:#c9e07b;border-color:rgba(164,208,7,.4);background:rgba(164,208,7,.1)}
    #slc .slc-quickbtn.q-sound{color:#c5a3ff;border-color:rgba(152,110,255,.4);background:rgba(152,110,255,.1)}
    #slc .slc-quickbtn.q-dlc{color:#ff9f7a;border-color:rgba(255,130,80,.4);background:rgba(255,130,80,.1)}
    #slc .slc-quickbtn.q-tool{color:#ffc82c;border-color:rgba(255,200,44,.4);background:rgba(255,200,44,.1)}
    #slc .slc-btn{border:0;border-radius:2px;padding:0 16px;line-height:30px;font-size:13px;cursor:pointer;font-family:inherit;transition:filter .15s}
    #slc .slc-btn:disabled{opacity:.35;cursor:default}
    #slc .slc-green{background:linear-gradient(-60deg,#6fa720 5%,#588a1b 95%);color:#d2efa9}
    #slc .slc-red{background:rgba(212,60,60,.25);color:#ff8a80}
    #slc .slc-ghost{background:rgba(103,193,245,.15);color:#67c1f5}
    #slc .slc-yellow{background:rgba(255,200,44,.18);color:#ffc82c}
    #slc .slc-set{margin-left:auto;display:flex;flex-wrap:wrap;gap:14px;color:#8f98a0;font-size:12px}
    #slc .slc-set label{display:flex;align-items:center;gap:6px}
    #slc .slc-set input{width:64px;padding:3px 6px;border-radius:2px;border:1px solid #000;background:rgba(0,0,0,.35);color:#fff;font-size:12px;box-shadow:1px 1px 0 rgba(255,255,255,.08)}
    #slc .slc-log{max-height:260px;overflow-y:auto;padding:10px 16px;background:rgba(0,0,0,.38);border-top:1px solid rgba(0,0,0,.4);font:12px/1.7 Consolas,"Courier New",monospace;color:#9fb0bd}
    #slc .slc-log div{white-space:pre-wrap;word-break:break-all}
    #slc .slc-log .t{color:#4b5d6b;margin-right:8px}
    #slc .slc-log .ok{color:#8ec14a}
    #slc .slc-log .skip{color:#7f8c97}
    #slc .slc-log .warn{color:#ffc82c}
    #slc .slc-log .err{color:#e0605e}
    #slc .slc-log .info{color:#67c1f5}
    #slc .slc-tabs{display:flex;align-items:center;flex-wrap:wrap;gap:2px;padding:0 10px;border-top:1px solid rgba(0,0,0,.4);background:rgba(0,0,0,.2)}
    #slc .slc-tab{background:none;border:0;border-bottom:2px solid transparent;color:#8f98a0;padding:10px 12px;font-size:13px;cursor:pointer;font-family:inherit}
    #slc .slc-tab:hover{color:#fff}
    #slc .slc-tab.on{color:#fff;border-bottom-color:#67c1f5;background:rgba(103,193,245,.08)}
    #slc .slc-tab em{font-style:normal;margin-left:6px;padding:0 7px;border-radius:8px;background:rgba(103,193,245,.18);color:#67c1f5;font-size:11px}
    #slc .slc-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:10px 16px;border-top:1px solid rgba(0,0,0,.4);background:rgba(0,0,0,.2);font-size:12px;color:#8f98a0}
    #slc .slc-tgroup{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
    #slc .slc-tgroup:empty{display:none}
    #slc .slc-tgroup + .slc-tgroup{padding-left:12px;border-left:1px solid rgba(103,193,245,.2)}
    #slc .slc-toolbar label{display:flex;align-items:center;gap:4px}
    #slc .slc-toolbar input,#slc .slc-toolbar select{padding:3px 6px;border-radius:2px;border:1px solid #000;background:rgba(0,0,0,.35);color:#fff;font-size:12px;font-family:inherit;color-scheme:dark;box-shadow:1px 1px 0 rgba(255,255,255,.08)}
    #slc .slc-toolbar .slc-search{width:170px}
    #slc .slc-toolbar select{max-width:200px}
    #slc .slc-toolbar button{border:1px solid rgba(103,193,245,.3);background:rgba(103,193,245,.1);color:#67c1f5;border-radius:2px;padding:3px 10px;font-size:12px;cursor:pointer;font-family:inherit}
    #slc .slc-toolbar button:hover:not(:disabled){background:rgba(103,193,245,.25);color:#fff}
    #slc .slc-toolbar button:disabled{opacity:.35;cursor:default}
    #slc .slc-toolbar .slc-warnbtn{color:#ffc82c;border-color:rgba(255,200,44,.4);background:rgba(255,200,44,.1)}
    #slc .slc-toolbar .slc-warnbtn:hover:not(:disabled){background:rgba(255,200,44,.25);color:#fff}
    #slc .slc-cat{border:1px solid rgba(103,193,245,.3) !important;border-radius:12px !important;padding:3px 10px !important;color:#8f98a0 !important}
    #slc .slc-cat.on{background:rgba(103,193,245,.45) !important;color:#fff !important;border-color:rgba(103,193,245,.75) !important;font-weight:600}
    #slc .slc-cat em{font-style:normal;margin-left:5px;color:#67c1f5;font-size:11px}
    #slc .slc-cat.on em{color:#fff}
    #slc .slc-selinfo{margin-left:auto;color:#67c1f5;font-variant-numeric:tabular-nums}
    #slc .slc-selinfo.flash{color:#ffc82c;font-weight:600}
    .slc-modal{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;font-family:"Motiva Sans",Arial,Helvetica,sans-serif}
    .slc-dialog{width:min(420px,92vw);padding:20px 22px;border-radius:3px;background:linear-gradient(135deg,#16202d,#1b2838);border:1px solid rgba(102,192,244,.3);box-shadow:0 0 24px rgba(0,0,0,.7);color:#c6d4df}
    .slc-dialog h3{margin:0 0 8px;font-size:16px;font-weight:600;color:#fff}
    .slc-dialog p{margin:0 0 18px;font-size:13px;line-height:1.6;color:#c6d4df}
    .slc-dialog-btns{display:flex;flex-wrap:wrap;gap:10px;justify-content:flex-end}
    .slc-dbtn{border:0;border-radius:2px;padding:0 16px;line-height:32px;font-size:13px;cursor:pointer;font-family:inherit}
    .slc-dscan{background:linear-gradient(-60deg,#6fa720 5%,#588a1b 95%);color:#d2efa9}
    .slc-dgo{background:rgba(212,60,60,.25);color:#ff8a80}
    .slc-dbtn:hover{filter:brightness(1.15)}
    #slc .slc-list{max-height:320px;overflow-y:auto;background:rgba(0,0,0,.38);border-top:1px solid rgba(0,0,0,.4);font-size:12px}
    #slc .slc-row{display:grid;grid-template-columns:minmax(0,1fr) 90px 260px;gap:12px;padding:6px 16px;align-items:center}
    #slc .slc-row.sel{grid-template-columns:24px minmax(0,1fr) 90px 260px}
    #slc .slc-row input[type=checkbox]{width:14px;height:14px;accent-color:#67c1f5;cursor:pointer;margin:0}
    #slc .slc-row:nth-child(even){background:rgba(255,255,255,.025)}
    #slc .slc-row:hover{background:rgba(103,193,245,.08)}
    #slc .slc-row .n{color:#c6d4df;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #slc .slc-row .i{color:#56707f;font-variant-numeric:tabular-nums}
    #slc .slc-row .x{color:#8f98a0;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #slc .slc-row .x.bad{color:#e0605e}
    #slc .slc-row.now .n{color:#a4d007}
    #slc .slc-empty,#slc .slc-more{padding:18px 16px;color:#56707f;text-align:center}
    #slc .slc-morebtn{border:1px solid rgba(103,193,245,.3);background:rgba(103,193,245,.1);color:#67c1f5;border-radius:2px;padding:3px 12px;font-size:12px;cursor:pointer;font-family:inherit;margin-left:6px}
    #slc .slc-morebtn:hover{background:rgba(103,193,245,.25);color:#fff}
    #slc .slc-pager{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 16px;border-top:1px solid rgba(0,0,0,.4);background:rgba(0,0,0,.2);font-size:12px;color:#8f98a0}
    #slc .slc-pager button{border:1px solid rgba(103,193,245,.3);background:rgba(103,193,245,.1);color:#67c1f5;border-radius:2px;padding:3px 10px;font-size:12px;cursor:pointer;font-family:inherit}
    #slc .slc-pager button:hover:not(:disabled){background:rgba(103,193,245,.25);color:#fff}
    #slc .slc-pager button:disabled{opacity:.35;cursor:default}
    #slc .slc-pager input,#slc .slc-pager select{padding:3px 6px;border-radius:2px;border:1px solid #000;background:rgba(0,0,0,.35);color:#fff;font-size:12px;font-family:inherit;color-scheme:dark}
    #slc .slc-pager input{width:56px}
    #slc .slc-pager .slc-pgsp{margin-left:auto}
    #slc-natbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:10px 0;padding:8px 12px;border-radius:3px;background:rgba(22,32,45,.9);border:1px solid rgba(102,192,244,.18);color:#8f98a0;font-size:12px;font-family:"Motiva Sans",Arial,Helvetica,sans-serif}
    #slc-natbar button{border:1px solid rgba(103,193,245,.3);background:rgba(103,193,245,.1);color:#67c1f5;border-radius:2px;padding:3px 10px;font-size:12px;cursor:pointer;font-family:inherit}
    #slc-natbar button:hover:not(:disabled){background:rgba(103,193,245,.25);color:#fff}
    #slc-natbar button:disabled{opacity:.35;cursor:default}
    #slc-natbar input{width:56px;padding:3px 6px;border-radius:2px;border:1px solid #000;background:rgba(0,0,0,.35);color:#fff;font-size:12px;color-scheme:dark}
    #slc-natbar .nat-hint{color:#ffc82c}
    @media (max-width:640px){#slc .slc-stats{grid-template-columns:repeat(2,1fr)}#slc .slc-set{margin-left:0}#slc .slc-row{grid-template-columns:minmax(0,1fr) 120px}#slc .slc-row .i{display:none}#slc .slc-row.sel{grid-template-columns:24px minmax(0,1fr) 120px}#slc .slc-toolbar .slc-search{width:100%}#slc .slc-tgroup + .slc-tgroup{padding-left:0;border-left:0}#slc .slc-selinfo{margin-left:0}#slc .slc-meta{flex-direction:column;gap:3px}#slc .slc-meta span:last-child{max-width:100%;text-align:left}#slc .slc-pager .slc-pgsp{margin-left:0}}
    `;

    function buildUI() {
        const titleElem = document.querySelector('.page_content > h2');
        if (!titleElem) return;
        natInit(); // must run before our panel is inserted, while the native table is still untouched
        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);

        const root = document.createElement('div');
        root.id = 'slc';
        root.innerHTML = `
          <div class="slc-head">
            <div class="slc-title">
              <svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9zm4 2v8h1.5v-8H10zm3.5 0v8H15v-8h-1.5z"/></svg>
              <span data-i18n="title"></span><em>v4.0</em>
            </div>
            <div class="slc-headr">
              <button class="slc-lang" data-k="lang" title="English / 中文"></button>
              <span class="slc-badge" data-k="badge"></span>
            </div>
          </div>
          <div class="slc-risk" data-i18n="riskBanner"></div>
          <div class="slc-stats">
            <div class="slc-stat"><b data-k="removed">0</b><span data-i18n="stat_removed"></span></div>
            <div class="slc-stat"><b data-k="skipped">0</b><span data-i18n="stat_skipped"></span></div>
            <div class="slc-stat"><b data-k="retry">0</b><span data-i18n="stat_retry"></span></div>
            <div class="slc-stat"><b data-k="perm">0</b><span data-i18n="stat_perm"></span></div>
            <div class="slc-stat"><b data-k="remain">0</b><span data-i18n="stat_remain"></span></div>
          </div>
          <div class="slc-prog">
            <div class="slc-bar"><i data-k="bar"></i></div>
            <div class="slc-meta"><span data-k="cur"></span><span data-k="eta"></span></div>
          </div>
          <div class="slc-cool" data-k="cool" hidden></div>
          <div class="slc-actions">
            <button class="slc-btn slc-green" data-k="start" data-i18n="btn_start"></button>
            <button class="slc-btn slc-ghost" data-k="scan" data-i18n="btn_scan" data-i18n-title="tip_scan"></button>
            <button class="slc-btn slc-red" data-k="stop" data-i18n="btn_stop" disabled></button>
            <button class="slc-btn slc-yellow" data-k="clearcool" data-i18n="btn_clearCool"></button>
            <button class="slc-btn slc-ghost" data-k="reset" data-i18n="btn_reset" data-i18n-title="tip_reset"></button>
            <button class="slc-btn slc-ghost" data-k="restoreskip" data-i18n="btn_restoreSkip" data-i18n-title="tip_restoreSkip"></button>
            <div class="slc-set">
              <label><span data-i18n="set_delay_pre"></span> <input type="number" min="0.5" step="0.5" data-k="delay"> <span data-i18n="set_delay_post"></span></label>
              <label><span data-i18n="set_cool_pre"></span> <input type="number" min="1" step="1" data-k="coolmin"> <span data-i18n="set_cool_post"></span></label>
              <label><span data-i18n="set_coolmax_pre"></span> <input type="number" min="1" max="180" step="1" data-k="coolmax"> <span data-i18n="set_coolmax_post"></span></label>
            </div>
            <button class="slc-btn slc-ghost" data-k="clearlog" data-i18n="btn_clearLog" data-i18n-title="tip_clearLog"></button>
          </div>
          <div class="slc-tabs">
            <button class="slc-tab on" data-tab="log"><span data-i18n="tab_log"></span></button>
            <button class="slc-tab" data-tab="pending"><span data-i18n="tab_pending"></span><em>0</em></button>
            <button class="slc-tab" data-tab="perm"><span data-i18n="tab_perm"></span><em>0</em></button>
            <button class="slc-tab" data-tab="deleted"><span data-i18n="tab_deleted"></span><em>0</em></button>
            <button class="slc-tab" data-tab="skipped"><span data-i18n="tab_skipped"></span><em>0</em></button>
            <button class="slc-tab" data-tab="failed"><span data-i18n="tab_failed"></span><em>0</em></button>
          </div>
          <div class="slc-toolbar" data-k="tbar" hidden>
            <div class="slc-tgroup">
              <input class="slc-search" type="search" data-k="fSearch">
              <select data-k="fMethod" title=""></select>
              <label><span data-i18n="f_from"></span><input type="date" data-k="fFrom"></label>
              <label><span data-i18n="f_to"></span><input type="date" data-k="fTo"></label>
              <button data-k="fClear" data-i18n="f_clear" hidden></button>
            </div>
            <div class="slc-tgroup" data-k="cats"></div>
            <div class="slc-tgroup" data-k="selgrp">
              <button data-k="selall" data-i18n="sel_all" data-i18n-title="tip_selAll"></button>
              <button data-k="selinv" data-i18n="sel_inv" data-i18n-title="tip_selInv"></button>
              <button data-k="selnone" data-i18n="sel_none" data-i18n-title="tip_selNone"></button>
              <button class="slc-warnbtn" data-k="skipsel" data-i18n="sel_skip" data-i18n-title="tip_skipSel"></button>
              <button class="slc-warnbtn" data-k="unskipsel" data-i18n="sel_unskip" data-i18n-title="tip_unskipSel" hidden></button>
            </div>
            <span class="slc-selinfo" data-k="selinfo"></span>
          </div>
          <div class="slc-log" data-k="log"></div>
          <div class="slc-list" data-k="list" hidden></div>
          <div class="slc-pager" data-k="pager" hidden></div>`;
        titleElem.parentNode.insertBefore(root, titleElem.nextSibling);

        els = { root };
        root.querySelectorAll('[data-k]').forEach(el => { els[el.dataset.k] = el; });
        root.querySelectorAll('.slc-tab').forEach(b => b.addEventListener('click', () => {
            view.tab = b.dataset.tab;
            view.page = 0;
            view.sig = '';
            render();
        }));

        // unified filter
        // The values are always remembered; filterTouched() only decides whether to warn / switch tab.
        els.fSearch.addEventListener('input', () => { view.f.q = els.fSearch.value.trim(); filterTouched(); view.sig = ''; render(); });
        els.fMethod.addEventListener('change', () => { view.f.method = els.fMethod.value; filterTouched(); view.sig = ''; render(); });
        els.fFrom.addEventListener('change', () => {
            view.f.from = els.fFrom.value ? new Date(els.fFrom.value + 'T00:00:00').getTime() : null;
            filterTouched(); view.sig = ''; render();
        });
        els.fTo.addEventListener('change', () => {
            view.f.to = els.fTo.value ? new Date(els.fTo.value + 'T23:59:59.999').getTime() : null;
            filterTouched(); view.sig = ''; render();
        });
        els.fClear.addEventListener('click', clearFilter);

        els.scan.addEventListener('click', scanOnly);
        els.clearcool.addEventListener('click', clearCooldown);
        els.clearlog.addEventListener('click', clearLog);
        els.restoreskip.addEventListener('click', restoreSkipped);
        els.selall.addEventListener('click', () => selectAll(true));
        els.selnone.addEventListener('click', () => selectAll(false));
        els.selinv.addEventListener('click', invertSel);
        els.skipsel.addEventListener('click', skipChecked);
        els.unskipsel.addEventListener('click', unskipChecked);
        els.lang.addEventListener('click', () => {
            state.lang = state.lang === 'zh' ? 'en' : 'zh';
            saveState();
            applyLang();
            view.sig = '';
            render();
        });

        els.delay.value = state.delaySec;
        els.coolmin.value = state.coolMin;
        els.coolmax.value = state.coolMaxMin;
        els.delay.addEventListener('change', () => {
            const v = parseFloat(els.delay.value);
            state.delaySec = v >= 0.5 ? v : CFG.delaySec;
            els.delay.value = state.delaySec;
            saveState();
        });
        els.coolmin.addEventListener('change', () => {
            const v = parseFloat(els.coolmin.value);
            state.coolMin = Math.min(state.coolMaxMin, Math.max(1, isFinite(v) ? v : CFG.coolMin));
            els.coolmin.value = state.coolMin;
            saveState();
        });
        els.coolmax.addEventListener('change', () => {
            const v = parseFloat(els.coolmax.value);
            state.coolMaxMin = Math.min(CFG.coolMaxLimit, Math.max(1, isFinite(v) ? v : CFG.coolMaxMin));
            els.coolmax.value = state.coolMaxMin;
            if (state.coolMin > state.coolMaxMin) {
                state.coolMin = state.coolMaxMin;
                els.coolmin.value = state.coolMin;
            }
            saveState();
        });
        els.start.addEventListener('click', () => runCleaning());
        els.stop.addEventListener('click', stopCleaning);
        els.reset.addEventListener('click', () => {
            if (run.running) return;
            if (!window.confirm(t('confirmReset'))) return;
            if (state.skipped.length || state.removed > 0 || deletedList.length) {
                const snap = {
                    skipped: state.skipped.slice(),
                    skippedInfo: Object.assign({}, state.skippedInfo),
                    skippedMeta: Object.assign({}, state.skippedMeta),
                    removed: state.removed,
                    coolLevel: state.coolLevel,
                    cooldownUntil: state.cooldownUntil,
                    deleted: deletedList.slice(),
                    time: Date.now()
                };
                try { localStorage.setItem(SKIP_BACKUP_KEY, JSON.stringify(snap)); }
                catch (e) { try { snap.deleted = []; localStorage.setItem(SKIP_BACKUP_KEY, JSON.stringify(snap)); } catch (e2) {} }
            }
            skipBackup = loadSkipBackup();
            state.skipped = []; skipSet.clear();
            state.removed = 0; state.minGap = 0; state.coolLevel = 0; state.cooldownUntil = 0;
            state.skippedInfo = {};
            state.skippedMeta = {};
            deletedList = [];
            saveDeleted();
            saveState();
            log(t('resetDone'), 'info');
            view.sig = '';
            render();
        });

        applyLang();
        setInterval(render, 500);
        render();
        natProbe();
    }

    /* ---------- native page pager (in-place, no navigation) ---------- */
    // Steam's own pagination is a token chain: the link to page N+1 only exists inside page N's HTML.
    // We keep every page's table HTML in memory (keyed by offset) and swap it into the native table.
    // The browser never navigates, so the cleaning loop keeps running. Pages already read by
    // "Scan list only" / cleaning are cached for free; only jumping beyond them fetches (one request per page).
    const nat = { pages: new Map(), cur: null, table: null, bar: null, busy: false, gone: new Set(), sig: '' };
    const natKeys = () => [...nat.pages.keys()].sort((a, b) => a - b);

    function natStore(offset, tableHTML, next) {
        if (tableHTML == null || nat.pages.has(offset)) return;
        nat.pages.set(offset, { tableHTML, next: next ? { token: next.token, offset: next.offset } : null });
    }

    function natHideGone(root) {
        if (!nat.gone.size) return;
        root.querySelectorAll('a[href^="javascript:RemoveFreeLicense"]').forEach(a => {
            const m = a.getAttribute('href').match(/RemoveFreeLicense\(\s*(\d+)\s*,/);
            if (m && nat.gone.has(m[1])) { const tr = a.closest('tr'); if (tr) tr.remove(); }
        });
    }

    // Called after every successful deletion so cached pages do not show rows that no longer exist.
    function natGone(id) {
        nat.gone.add(String(id));
        if (nat.table) natHideGone(nat.table);
    }

    function natShow(offset) {
        const p = nat.pages.get(offset);
        if (!p || !nat.table) return;
        nat.cur = offset;
        nat.table.innerHTML = p.tableHTML;
        natHideGone(nat.table);
        nat.sig = '';
        natBar();
    }

    async function natFetch(n) {
        const url = `https://store.steampowered.com/account/licenses/?continuationToken=${n.token}&offset=${n.offset}`;
        for (let k = 0; k < 3; k++) {
            try {
                const resp = await fetch(url, { credentials: 'same-origin' });
                if (resp.ok) {
                    const html = await resp.text();
                    const doc = new DOMParser().parseFromString(html, 'text/html');
                    const tb = doc.querySelector('.account_table');
                    natStore(n.offset, tb ? tb.innerHTML : null, findNext(html, n.offset));
                    return nat.pages.has(n.offset);
                }
            } catch (e) {}
            await sleep(rand(CFG.netRetryDelay));
        }
        log(t('nat_err'), 'warn');
        return false;
    }

    async function natGoIndex(i) {
        if (nat.busy) return;
        nat.busy = true; nat.sig = ''; natBar();
        try {
            const keys = natKeys();
            if (i > keys.length - 1) log(t('nat_scanfirst'), 'warn');
            i = Math.min(Math.max(0, i), keys.length - 1);
            natShow(keys[i]);
        } finally { nat.busy = false; nat.sig = ''; natBar(); }
    }

    async function natGoOffset(n) { // n = {token, offset} taken from a native link
        if (nat.busy) return;
        if (!nat.pages.has(n.offset)) {
            log(t('nat_scanfirst'), 'warn');
            return;
        }
        natShow(n.offset);
    }

    function natBar() {
        if (!nat.bar) return;
        const keys = natKeys();
        if (!keys.length) return;
        const last = nat.pages.get(keys[keys.length - 1]);
        const complete = !!last && !last.next;
        const i = keys.indexOf(nat.cur);
        const sig = [keys.length, i, complete, nat.busy, run.running, state.lang].join('|');
        if (sig === nat.sig) return;
        const ae = document.activeElement;
        if (ae && ae.tagName === 'INPUT' && nat.bar.contains(ae)) return; // only protect typing in the page box
        nat.sig = sig;
        const bar = nat.bar;
        bar.textContent = '';
        const mk = (label, idx, dis) => {
            const b = document.createElement('button');
            b.textContent = label; b.disabled = dis || nat.busy;
            b.addEventListener('click', () => natGoIndex(idx));
            bar.appendChild(b);
        };
        const canNext = i < keys.length - 1;
        mk('«', 0, i <= 0);
        mk('‹', i - 1, i <= 0);
        const s = document.createElement('span');
        s.textContent = t('nat_page', i + 1, keys.length + (complete ? '' : '+'));
        bar.appendChild(s);
        mk('›', i + 1, !canNext);
        mk('»', keys.length - 1, i >= keys.length - 1);
        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = 1; inp.value = i + 1;
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') natGoIndex((parseInt(inp.value, 10) || 1) - 1); });
        bar.appendChild(inp);
        const go = document.createElement('button');
        go.textContent = t('nat_go'); go.disabled = nat.busy;
        go.addEventListener('click', () => natGoIndex((parseInt(inp.value, 10) || 1) - 1));
        bar.appendChild(go);
        const h = document.createElement('span');
        h.className = 'nat-hint';
        h.textContent = nat.busy ? t('nat_loading') : (run.running ? t('nat_cacheonly') : (!complete ? t('nat_scanhint') : ''));
        bar.appendChild(h);
    }

    function natProbe() {
        if (!nat.table) { log(t('nat_notable'), 'warn'); return; }
        log(t('nat_ready'), 'info');
    }

    function natInit() {
        nat.table = document.querySelector('.account_table');
        if (!nat.table) return;
        const m = location.search.match(/offset=(\d+)/);
        const offset = m ? +m[1] : 0;
        natStore(offset, nat.table.innerHTML, findNext(document.documentElement.innerHTML, offset));
        nat.cur = offset;
        const bar = document.createElement('div');
        bar.id = 'slc-natbar';
        nat.table.parentNode.insertBefore(bar, nat.table);
        nat.bar = bar;
        // Steam's own "next page" links would reload the page and kill a running clean: handle them in place.
        document.addEventListener('click', e => {
            const a = e.target.closest && e.target.closest('a[href*="continuationToken"]');
            if (!a || a.closest('#slc') || !a.closest('.page_content')) return;
            const mm = a.getAttribute('href').match(/continuationToken=([^&"'\s<>]+)(?:&amp;|&)offset=(\d+)/) ||
                       a.getAttribute('href').match(/offset=(\d+)(?:&amp;|&)continuationToken=([^&"'\s<>]+)/);
            if (!mm) return;
            const isTokenFirst = /continuationToken=[^&]+(?:&amp;|&)offset=/.test(a.getAttribute('href'));
            const n = isTokenFirst ? { token: mm[1], offset: +mm[2] } : { token: mm[2], offset: +mm[1] };
            e.preventDefault();
            natGoOffset(n);
        }, true);
        natBar();
    }

    /* ---------- unified filter ---------- */

    function newFilter() { return { q: '', method: '', from: null, to: null, cats: new Set() }; }

    function fActive() {
        const f = view.f;
        return !!(f.q || f.method || f.from !== null || f.to !== null || f.cats.size);
    }

    function fToken() {
        const f = view.f;
        return `${f.q}|${f.method}|${f.from}|${f.to}|${[...f.cats].sort().join(',')}`;
    }

    // One matcher for every tab. cats may be undefined (derived from the name).
    function matchFields(name, id, cats, method, date, ignoreCats) {
        const f = view.f;
        if (f.q) {
            const q = f.q.toLowerCase();
            if (!String(name).toLowerCase().includes(q) && !String(id).includes(q)) return false;
        }
        if (!ignoreCats && f.cats.size) {
            const c = cats || categorize(String(name));
            if (!c.some(x => f.cats.has(x))) return false;
        }
        if (f.method && method !== f.method) return false;
        if (f.from !== null || f.to !== null) {
            if (date == null) return false;
            if (f.from !== null && date < f.from) return false;
            if (f.to !== null && date > f.to) return false;
        }
        return true;
    }

    function matchG(g, ignoreCats) {
        return matchFields(g.itemName, g.packageId, g.cats, g.method, g.date, ignoreCats);
    }

    function skippedMetaOf(id) {
        const m = state.skippedMeta[id] || {};
        return { m: m.m || '', d: m.d == null ? null : m.d, t: m.t || '', x: m.x ? 1 : 0 };
    }

    function skippedVisible() {
        return state.skipped.filter(id => {
            const m = skippedMetaOf(id);
            return matchFields(state.skippedInfo[id] || '', id, null, m.m, m.d);
        });
    }

    /* ---------- "not scanned yet" handling ---------- */

    // Log / pending / not-removable tabs need scan data; deleted / skipped / failed have their own records.
    function needsScan(tab) { return tab === 'log' || tab === 'pending' || tab === 'perm'; }
    function hasScan() { return run.running || run.scanList.length > 0 || run.nonRemovableList.length > 0; }

    let lastUnscannedNotice = 0, flashTimer = null;
    function notifyUnscanned(force) {
        if (!els) return;
        const now = Date.now();
        els.selinfo.textContent = t('notScanned');
        els.selinfo.classList.add('flash');
        if (flashTimer) clearTimeout(flashTimer);
        flashTimer = setTimeout(() => els.selinfo.classList.remove('flash'), 2500);
        if (force || now - lastUnscannedNotice > 3000) log(t('notScanned'), 'warn');
        lastUnscannedNotice = now;
    }

    // Called whenever the user touches a filter control.
    // Returns true when the filter may be applied normally.
    function filterTouched() {
        view.page = 0; // a new filter always starts from the first page
        if (needsScan(view.tab) && !hasScan()) { notifyUnscanned(false); return false; }
        if (view.tab === 'log') { view.tab = 'pending'; } // show the filtered result list
        return true;
    }

    function clearFilter() {
        view.page = 0;
        view.f = newFilter();
        if (els) {
            els.fSearch.value = '';
            els.fMethod.value = '';
            els.fFrom.value = '';
            els.fTo.value = '';
        }
        view.sig = '';
        render();
    }

    function toggleCatFilter(cat) {
        view.page = 0;
        if (view.f.cats.has(cat)) view.f.cats.delete(cat); else view.f.cats.add(cat);
        view.sig = '';
        render();
    }

    /* ---------- selection (acts on the whole filtered result, across all pages) ---------- */

    function selectAll(checked) {
        if (run.running) return;
        if (view.tab === 'pending' && !run.scanList.length) { notifyUnscanned(true); return; }
        if (view.tab === 'skipped') {
            skippedVisible().forEach(id => { if (checked) view.skipSel.add(id); else view.skipSel.delete(id); });
        } else if (view.tab === 'pending') {
            run.scanList.forEach(g => { if (matchG(g)) g.checked = checked; });
        }
        view.sig = '';
        render();
    }

    function invertSel() {
        if (run.running) return;
        if (view.tab === 'pending' && !run.scanList.length) { notifyUnscanned(true); return; }
        if (view.tab === 'skipped') {
            skippedVisible().forEach(id => { if (view.skipSel.has(id)) view.skipSel.delete(id); else view.skipSel.add(id); });
        } else if (view.tab === 'pending') {
            run.scanList.forEach(g => { if (matchG(g)) g.checked = !g.checked; });
        }
        view.sig = '';
        render();
    }

    async function unskipChecked() {
        if (run.running) return;
        const ids = skippedVisible().filter(id => view.skipSel.has(id));
        if (!ids.length) { log(t('unskipNone'), 'warn'); return; }
        const restored = ids.map(id => {
            const name = state.skippedInfo[id] || t('unknownName');
            const meta = skippedMetaOf(id);
            skipSet.delete(id);
            delete state.skippedInfo[id];
            delete state.skippedMeta[id];
            return {
                packageId: id, itemName: name, attempts: 0, cats: categorize(name), checked: true,
                dateText: meta.t, date: meta.d, method: meta.m
            };
        });
        const idSet = new Set(ids);
        state.skipped = state.skipped.filter(id => !idSet.has(id));
        view.skipSel.clear();
        saveState();

        if (run.scanList.length) {
            const have = new Set(run.scanList.map(g => g.packageId));
            restored.forEach(g => { if (!have.has(g.packageId)) run.scanList.push(g); });
            log(t('unskipDone', ids.length, run.scanList.length), 'ok');
            view.tab = 'pending';
            view.page = 0;
            view.sig = '';
            render();
        } else {
            log(t('unskipScanning', ids.length), 'info');
            view.sig = '';
            render();
            await scanOnly();
        }
    }

    function skipChecked() {
        if (run.running) return;
        if (!run.scanList.length) { notifyUnscanned(true); return; }
        let added = 0;
        const keep = [];
        for (const g of run.scanList) {
            if (g.checked && matchG(g)) { addToSkipped(g); added++; }
            else keep.push(g);
        }
        if (!added) { log(t('skipSelNone'), 'warn'); return; }
        run.scanList = keep;
        saveState();
        log(t('skipSelDone', added, state.skipped.length), 'ok');
        view.sig = '';
        render();
    }

    function clearCooldown() {
        const hadCooldown = state.cooldownUntil > Date.now();
        state.cooldownUntil = 0;
        state.coolLevel = 0;
        saveState();
        if (hadCooldown) log(t('coolCleared'), 'info');
        view.sig = '';
        render();
    }

    function clearLog() {
        if (!els || !els.log) return;
        els.log.textContent = '';
        els.log.scrollTop = 0;
    }

    function backupHasContent(b) {
        return !!b && !!((b.skipped && b.skipped.length) || b.removed > 0 || (b.deleted && b.deleted.length));
    }

    function restoreSkipped() {
        if (run.running) return;
        const b = loadSkipBackup();
        if (!backupHasContent(b)) { log(t('restoreEmpty'), 'warn'); return; }
        let added = 0;
        for (const id of (b.skipped || [])) {
            if (!skipSet.has(id)) { skipSet.add(id); state.skipped.push(id); added++; }
            if (b.skippedInfo && b.skippedInfo[id] && !state.skippedInfo[id]) state.skippedInfo[id] = b.skippedInfo[id];
            if (b.skippedMeta && b.skippedMeta[id] && !state.skippedMeta[id]) state.skippedMeta[id] = b.skippedMeta[id];
        }
        const r = Number(b.removed) > 0 ? Math.floor(Number(b.removed)) : 0;
        state.removed += r;
        let d = 0;
        if (Array.isArray(b.deleted) && b.deleted.length) {
            const have = new Set(deletedList.map(e => e[0] + '|' + e[2]));
            const add = b.deleted.filter(e => !have.has(e[0] + '|' + e[2]));
            deletedList = add.concat(deletedList);
            if (deletedList.length > DEL_MAX) deletedList.splice(0, deletedList.length - DEL_MAX);
            d = add.length;
            saveDeleted();
        }
        state.coolLevel = Math.max(state.coolLevel || 0, Number(b.coolLevel) || 0);
        state.cooldownUntil = Math.max(state.cooldownUntil || 0, Number(b.cooldownUntil) || 0);
        try { localStorage.removeItem(SKIP_BACKUP_KEY); } catch (e) {}
        skipBackup = null;
        saveState();
        log(t('restoreDone', added, state.skipped.length, r, d), 'info');
        view.sig = '';
        render();
    }

    function applyLang() {
        if (!els) return;
        els.root.querySelectorAll('[data-i18n]').forEach(e => { e.textContent = t(e.dataset.i18n); });
        els.root.querySelectorAll('[data-i18n-title]').forEach(e => { e.title = t(e.dataset.i18nTitle); });
        els.fSearch.placeholder = t('filterPh');
        els.fMethod.title = t('f_method');
        // Placeholder-style first option, so the dropdown is never blank before a scan.
        if (!els.fMethod.options.length) els.fMethod.add(new Option(t('f_anyMethod'), ''));
        else els.fMethod.options[0].text = t('f_anyMethod');
        els.lang.textContent = state.lang === 'zh' ? 'EN' : '中文';
        document.documentElement.setAttribute('data-slc-lang', state.lang);
    }

    function log(msg, type) {
        if (!els) return;
        const d = document.createElement('div');
        if (type) d.className = type;
        const ts = document.createElement('span');
        ts.className = 't';
        ts.textContent = new Date().toTimeString().slice(0, 8);
        d.appendChild(ts);
        d.appendChild(document.createTextNode(msg));
        const box = els.log;
        const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
        box.appendChild(d);
        while (box.childElementCount > 400) box.removeChild(box.firstChild);
        if (nearBottom) box.scrollTop = box.scrollHeight;
    }

    // page / pageSize are pure view state: changing them never touches run.* or localStorage records.
    const view = { tab: 'log', sig: '', page: 0, pageSize: state.pageSize, skipSel: new Set(), f: newFilter(), rows: [], shown: [], optSig: '' };

    function fmtWhen(ts) {
        const d = new Date(ts), now = new Date();
        const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
        return d.toDateString() === now.toDateString() ? hm : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
    }

    // All rows of a tab, unfiltered. Every row carries name/id/cats/method/date so one filter fits all tabs.
    function listRows(tab) {
        const rows = [];
        if (tab === 'pending') {
            if (!run.running && run.scanList.length) {
                run.scanList.forEach((g, idx) => rows.push({
                    id: g.packageId, name: g.itemName, cats: g.cats, method: g.method, date: g.date,
                    checked: !!g.checked, idx, selectable: true,
                    extra: [g.cats.map(c => t('cat_' + c)).join('/'), g.dateText, g.method].filter(Boolean).join(' · ')
                }));
            } else {
                const add = (g, extra, now) => rows.push({
                    id: g.packageId, name: g.itemName, cats: g.cats, method: g.method, date: g.date, extra, now
                });
                if (run.cur) add(run.cur, t('processing'), true);
                run.queue.forEach((g, i) => add(g, t('queuePos', i + 1)));
                if (run.tail && run.tail.length) run.tail.forEach((g, i) => add(g, t('tailPos', i + 1)));
            }
        } else if (tab === 'perm') {
            for (let i = run.nonRemovableList.length - 1; i >= 0; i--) {
                const g = run.nonRemovableList[i];
                rows.push({
                    id: g.packageId || '', name: g.itemName, cats: g.cats, method: g.method, date: g.date,
                    extra: [g.dateText, g.method].filter(Boolean).join(' · ')
                });
            }
        } else if (tab === 'deleted') {
            for (let i = deletedList.length - 1; i >= 0; i--) {
                const e = deletedList[i];
                rows.push({
                    id: e[0], name: e[1], cats: null, method: e[3] || '', date: e[4] == null ? null : e[4],
                    extra: [e[5], e[3], fmtWhen(e[2])].filter(Boolean).join(' · ')
                });
            }
        } else if (tab === 'skipped') {
            for (let i = state.skipped.length - 1; i >= 0; i--) {
                const id = state.skipped[i];
                const m = skippedMetaOf(id);
                rows.push({
                    id, name: state.skippedInfo[id] || t('nameMissing'), cats: null, method: m.m, date: m.d,
                    extra: [t('errCode', 29), m.t, m.m].filter(Boolean).join(' · '),
                    selectable: !run.running, skipId: id, checked: view.skipSel.has(id)
                });
            }
        } else if (tab === 'failed') {
            const add = (g, extra, bad) => rows.push({
                id: g.packageId, name: g.itemName, cats: g.cats, method: g.method, date: g.date, extra, bad
            });
            run.retry.forEach(g => add(g, t('retryExtra', g.attempts, CFG.maxAttempts, g.lastErr || '')));
            run.gaveUp.forEach(g => add(g, t('gaveExtra', g.lastErr || ''), true));
        }
        return rows;
    }

    function rowMatches(r, ignoreCats) {
        return matchFields(r.name, r.id, r.cats, r.method, r.date, ignoreCats);
    }

    function updateInfo() {
        if (!els || !els.selinfo) return;
        if (needsScan(view.tab) && !hasScan()) { els.selinfo.textContent = t('notScanned'); return; }
        if (view.tab === 'log') { els.selinfo.textContent = ''; return; }
        let txt = t('fInfo', view.shown.length, view.rows.length);
        if (view.tab === 'pending' && !run.running && run.scanList.length) {
            let sel = 0, hid = 0;
            for (const g of run.scanList) if (g.checked) { sel++; if (!matchG(g)) hid++; }
            txt += ' · ' + t('sel_info', sel) + (hid ? t('sel_hidden', hid) : '');
        } else if (view.tab === 'skipped' && !run.running && state.skipped.length) {
            const vis = new Set(skippedVisible());
            let sel = 0, hid = 0;
            for (const id of state.skipped) if (view.skipSel.has(id)) { sel++; if (!vis.has(id)) hid++; }
            txt += ' · ' + t('sel_info', sel) + (hid ? t('sel_hidden', hid) : '');
        }
        els.selinfo.textContent = txt;
    }

    function renderCatButtons() {
        if (!els || !els.cats) return;
        els.cats.textContent = '';
        const counts = {};
        for (const r of view.rows) {
            if (!rowMatches(r, true)) continue;
            for (const c of (r.cats || categorize(String(r.name)))) counts[c] = (counts[c] || 0) + 1;
        }
        const active = view.f.cats;
        ['risk29', 'demo', 'soundtrack', 'dlc', 'tool', 'game'].forEach(cat => {
            const n = counts[cat] || 0;
            if (!n && !active.has(cat)) return;
            const b = document.createElement('button');
            b.className = 'slc-cat' + (active.has(cat) ? ' on' : '');
            b.textContent = t('cat_' + cat);
            if (cat === 'risk29') b.title = t('tip_risk29');
            const em = document.createElement('em');
            em.textContent = n;
            b.appendChild(em);
            b.addEventListener('click', () => toggleCatFilter(cat));
            els.cats.appendChild(b);
        });
    }

    function renderMethodOptions() {
        if (!els || !els.fMethod) return;
        if (document.activeElement === els.fMethod) return; // do not rebuild while the dropdown is in use
        const cur = view.f.method;
        const counts = new Map();
        view.rows.forEach(r => { if (r.method) counts.set(r.method, (counts.get(r.method) || 0) + 1); });
        const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        const optSig = state.lang + '|' + cur + '|' + entries.map(e => e[0] + ':' + e[1]).join(';');
        if (optSig === view.optSig) return;
        view.optSig = optSig;
        els.fMethod.textContent = '';
        els.fMethod.add(new Option(t('f_anyMethod'), ''));
        entries.forEach(([k, n]) => els.fMethod.add(new Option(`${k} (${n})`, k)));
        if (cur && !counts.has(cur)) els.fMethod.add(new Option(`${cur} (0)`, cur));
        els.fMethod.value = cur || '';
    }

    // Pager: only changes view.page / view.pageSize and redraws. No network, no run.* state is touched.
    function renderPager(pages, total) {
        const p = els.pager;
        p.textContent = '';
        p.hidden = total <= 0;
        if (total <= 0) return;
        const go = n => {
            view.page = Math.min(Math.max(0, n), pages - 1);
            view.sig = '';
            render();
        };
        const mk = (label, n, dis) => {
            const b = document.createElement('button');
            b.textContent = label;
            b.disabled = dis;
            b.addEventListener('click', () => go(n));
            p.appendChild(b);
        };
        mk('«', 0, view.page <= 0);
        mk('‹', view.page - 1, view.page <= 0);
        const s = document.createElement('span');
        s.textContent = t('pg_page', view.page + 1, pages, total);
        p.appendChild(s);
        mk('›', view.page + 1, view.page >= pages - 1);
        mk('»', pages - 1, view.page >= pages - 1);

        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = 1; inp.max = pages; inp.value = view.page + 1;
        inp.title = t('pg_jump');
        inp.addEventListener('change', () => go((parseInt(inp.value, 10) || 1) - 1));
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') go((parseInt(inp.value, 10) || 1) - 1); });
        p.appendChild(inp);

        const sel = document.createElement('select');
        sel.className = 'slc-pgsp';
        [20, 50, 100, 200, 500].forEach(n => sel.add(new Option(t('pg_size', n), n)));
        sel.value = String(view.pageSize);
        sel.addEventListener('change', () => {
            view.pageSize = +sel.value;
            state.pageSize = view.pageSize;
            saveState();
            go(0);
        });
        p.appendChild(sel);
    }

    function renderList(tab) {
        const rows = view.rows;
        const shown = view.shown = rows.filter(r => rowMatches(r));
        const box = els.list;
        const top = box.scrollTop;
        box.textContent = '';

        if (!shown.length) {
            const d = document.createElement('div');
            d.className = 'slc-empty';
            const emptyKey = { pending: 'emptyPending', perm: 'emptyPerm', deleted: 'emptyDeleted', skipped: 'emptySkipped', failed: 'emptyFailed' }[tab];
            d.textContent = (rows.length && fActive()) ? t('noFilterMatch') : t(emptyKey);
            box.appendChild(d);
            els.pager.hidden = true;
            return;
        }

        const pageSize = view.pageSize;
        const pages = Math.max(1, Math.ceil(shown.length / pageSize));
        view.page = Math.min(Math.max(0, view.page), pages - 1); // clamp: the list may shrink while cleaning
        const start = view.page * pageSize;

        const frag = document.createDocumentFragment();
        shown.slice(start, start + pageSize).forEach(r => {
            const row = document.createElement('div');
            row.className = 'slc-row' + (r.now ? ' now' : '') + (r.selectable ? ' sel' : '');
            if (r.selectable) {
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = r.checked;
                cb.addEventListener('change', () => {
                    if (r.skipId !== undefined) {
                        if (cb.checked) view.skipSel.add(r.skipId); else view.skipSel.delete(r.skipId);
                    } else {
                        const g = run.scanList[r.idx];
                        if (g) g.checked = cb.checked;
                    }
                    updateInfo();
                });
                row.appendChild(cb);
            }
            const n = document.createElement('span'); n.className = 'n'; n.textContent = r.name; n.title = r.name;
            const i = document.createElement('span'); i.className = 'i'; i.textContent = r.id;
            const x = document.createElement('span'); x.className = 'x' + (r.bad ? ' bad' : ''); x.textContent = r.extra || ''; x.title = r.extra || '';
            row.append(n, i, x);
            frag.appendChild(row);
        });
        box.appendChild(frag);
        box.scrollTop = top;
        renderPager(pages, shown.length);
    }

    function renderTabs() {
        const counts = {
            pending: (!run.running && run.scanList.length)
                ? run.scanList.length
                : run.queue.length + (run.cur ? 1 : 0) + (run.tail ? run.tail.length : 0),
            perm: run.nonRemovableList.length,
            deleted: deletedList.length,
            skipped: state.skipped.length,
            failed: run.retry.size + run.gaveUp.size
        };
        els.root.querySelectorAll('.slc-tab').forEach(b => {
            const k = b.dataset.tab;
            b.classList.toggle('on', k === view.tab);
            const em = b.querySelector('em');
            if (em) em.textContent = counts[k];
        });

        const isLog = view.tab === 'log';
        els.log.hidden = !isLog;
        els.list.hidden = isLog;
        els.tbar.hidden = false; // the filter toolbar is always visible
        if (isLog) els.pager.hidden = true;

        // toolbar: the filter is always there; selection actions only where they make sense.
        // Buttons stay clickable when nothing is scanned so they can explain why nothing happens.
        const isPending = view.tab === 'pending', isSkipped = view.tab === 'skipped';
        els.selgrp.hidden = !(isPending || isSkipped);
        els.selall.disabled = els.selinv.disabled = els.selnone.disabled = run.running;
        els.skipsel.hidden = !isPending;
        els.skipsel.disabled = run.running;
        els.unskipsel.hidden = !isSkipped;
        els.unskipsel.disabled = run.running || !state.skipped.length;
        els.fClear.hidden = !fActive();
        if (isLog) { updateInfo(); return; }

        const pendingToken = (!run.running && run.scanList.length)
            ? `S${run.scanList.length}`
            : `${run.queue.length}|${run.queue[0] ? run.queue[0].packageId : ''}|${run.cur ? run.cur.packageId : ''}|${run.tail ? run.tail.length : 0}`;
        const token = {
            pending: pendingToken,
            perm: run.nonRemovableList.length,
            deleted: deletedList.length,
            skipped: state.skipped.length,
            failed: `${run.retry.size}|${run.gaveUp.size}|${[...run.retry.values()].reduce((a, g) => a + g.attempts, 0)}`
        }[view.tab];
        const sig = `${state.lang}|${view.tab}|${run.running}|${fToken()}|${view.page}|${view.pageSize}|${token}`;
        if (sig === view.sig) return;
        view.sig = sig;

        view.rows = listRows(view.tab);
        renderMethodOptions();
        renderCatButtons();
        renderList(view.tab);
        updateInfo();
    }

    function render() {
        if (!els) return;
        const left = Math.max(0, state.cooldownUntil - Date.now());
        const ctl = run.ctl;

        let cls = '', label = t('b_idle');
        if (run.scanning) { cls = 'run'; label = t('b_scanning'); }
        else if (run.running) { cls = left > 0 ? 'cool' : 'run'; label = left > 0 ? t('b_cool') : t('b_run'); }
        else if (run.last === 'done') { cls = 'done'; label = t('b_done'); }
        else if (run.last === 'scanned') { cls = 'done'; label = t('b_scanned'); }
        else if (run.last === 'stopped') { label = t('b_stopped'); }
        els.badge.className = 'slc-badge ' + cls;
        els.badge.textContent = label;

        els.removed.textContent = state.removed;
        els.skipped.textContent = state.skipped.length;
        els.retry.textContent = run.retry.size;
        els.perm.textContent = run.nonRemovableList.length;
        const remain = ctl ? Math.max(0, ctl.total - ctl.finished) : 0;
        els.remain.textContent = remain + (ctl && !ctl.readerDone ? '+' : '');

        const pct = ctl && ctl.total ? Math.min(100, ctl.finished / ctl.total * 100) : 0;
        els.bar.style.width = pct.toFixed(1) + '%';

        if (run.scanning) els.cur.textContent = t('curScanning', ctl ? ctl.pages : 0, ctl ? ctl.total : 0);
        else if (run.running && run.preparing) els.cur.textContent = t('curPreparing');
        else if (run.running && run.current) els.cur.textContent = t('curProcessing', run.current);
        else if (!run.running && run.last === 'scanned') els.cur.textContent = t('curScanDone', run.scanList.length);
        else if (!run.running && run.last) els.cur.textContent = run.last === 'done' ? t('curAllDone') : t('curStopped');
        else els.cur.textContent = t('notStarted');

        let eta = '';
        if (run.running && !run.scanning && remain > 0) {
            const basePer = state.delaySec * 1000 + state.minGap + 800;
            const actualPer = run.processed > 0 ? (Date.now() - run.startAt) / run.processed : basePer;
            let per;
            if (run.processed >= 3) per = actualPer;
            else per = (basePer * (3 - run.processed) + actualPer * run.processed) / 3;
            const ms = per * remain + left;
            eta = t('eta', fmtDhm(ms), fmtAt(ms));
            if (ctl && !ctl.readerDone) eta += (state.lang === 'zh' ? '' : ' ') + t('etaReading');
        } else if (ctl && ctl.total && !run.scanning && run.last !== 'scanned') {
            eta = `${ctl.finished} / ${ctl.total}`;
        }
        els.eta.textContent = eta;

        if (left > 0) {
            els.cool.hidden = false;
            els.cool.innerHTML = t('coolBar', fmtClock(left), state.coolLevel, run.running);
        } else els.cool.hidden = true;

        els.start.disabled = run.running;
        els.scan.disabled = run.running;
        els.stop.disabled = !run.running;
        els.reset.disabled = run.running;
        els.clearcool.disabled = left <= 0;
        els.restoreskip.disabled = run.running || !backupHasContent(skipBackup);
        natBar();
        renderTabs();

        document.title = run.running && ctl && ctl.total ? `[${ctl.finished}/${ctl.total}] ${origTitle}` : origTitle;
    }

    async function waitInterruptible(ms, label) {
        const end = Date.now() + ms;
        if (label && ms > 10000) log(t('logWait', label, Math.round(ms / 1000)), 'info');
        while (Date.now() < end) {
            if (!run.running) return false;
            await sleep(Math.min(500, Math.max(0, end - Date.now())));
        }
        return run.running;
    }

    async function honorCooldown() {
        while (run.running) {
            const left = state.cooldownUntil - Date.now();
            if (left <= 0) return true;
            await sleep(Math.min(500, left));
        }
        return false;
    }

    function parseLicenses(doc) {
        const removable = [];
        const nonRemovable = [];
        doc.querySelectorAll('.account_table tr').forEach(row => {
            const cells = row.querySelectorAll('td');
            if (!cells.length) return;
            const itemName = cells[1] ? cells[1].textContent.trim() : t('unknownName');
            const dateEl = row.querySelector('.license_date_col') || cells[0];
            const methodEl = row.querySelector('.license_acquisition_col') || cells[cells.length - 1];
            const dateText = dateEl ? dateEl.textContent.trim() : '';
            const method = methodEl && methodEl !== cells[1]
                ? methodEl.textContent.trim().replace(/\s+/g, ' ') : '';
            const link = row.querySelector('a[href^="javascript:RemoveFreeLicense"]');
            if (link) {
                const match = link.getAttribute('href').match(/RemoveFreeLicense\(\s*(\d+)\s*,/);
                if (!match) return;
                const packageId = match[1];
                if (skipSet.has(packageId) || run.gaveUp.has(packageId)) return;
                removable.push({ packageId, itemName, attempts: 0, dateText, date: parseDate(dateText), method });
            } else {
                let pid = '';
                const m1 = row.innerHTML.match(/subid["'\s:=]+(\d+)/i) ||
                           row.innerHTML.match(/packageid["'\s:=]+(\d+)/i) ||
                           row.innerHTML.match(/appid["'\s:=]+(\d+)/i);
                if (m1) pid = m1[1];
                nonRemovable.push({ packageId: pid, itemName, dateText, date: parseDate(dateText), method });
            }
        });
        return { removable, nonRemovable };
    }

    function findNext(html, curOffset) {
        let best = null;
        const consider = (token, offset) => {
            if (offset > curOffset && (!best || offset < best.offset)) best = { token, offset };
        };
        let m;
        const re1 = /continuationToken=([^&"'\s<>]+)(?:&amp;|&)offset=(\d+)/g;
        while ((m = re1.exec(html))) consider(m[1], +m[2]);
        const re2 = /offset=(\d+)(?:&amp;|&)continuationToken=([^&"'\s<>]+)/g;
        while ((m = re2.exec(html))) consider(m[2], +m[1]);
        return best;
    }

    async function fetchPage(url) {
        for (let n = 0; n < 5; n++) {
            if (!run.running) return null;
            try {
                const resp = await fetch(url, { credentials: 'same-origin' });
                if (resp.ok) return await resp.text();
                log(t('pageHttp', resp.status), 'warn');
            } catch (e) { log(t('pageErr', e.message), 'warn'); }
            if (!(await waitInterruptible(rand(CFG.netRetryDelay)))) return null;
        }
        return null;
    }

    async function readerTask(queue, ctl) {
        const seen = new Set();
        let url = 'https://store.steampowered.com/account/licenses/';
        let offset = 0;
        try {
            for (let page = 1; page <= CFG.maxPages && run.running; page++) {
                const html = await fetchPage(url);
                if (html === null) break;
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const parsed = parseLicenses(doc);
                const next = findNext(html, offset);
                const natTb = doc.querySelector('.account_table');
                natStore(offset, natTb ? natTb.innerHTML : null, next); // feeds the native pager cache for free
                for (const g of parsed.removable) {
                    if (seen.has(g.packageId)) continue;
                    if (run.allowedSet && !run.allowedSet.has(g.packageId)) continue;
                    seen.add(g.packageId);
                    g.cats = categorize(g.itemName);
                    g.checked = true;
                    queue.push(g);
                    ctl.total++;
                }
                for (const g of parsed.nonRemovable) {
                    const key = g.itemName + '|' + g.dateText + '|' + g.method;
                    if (run.nonRemovableSeen.has(key)) continue;
                    run.nonRemovableSeen.add(key);
                    g.cats = categorize(g.itemName);
                    run.nonRemovableList.push(g);
                }
                ctl.pages = page;
                if (page % 5 === 1) log(t('readProg', page, ctl.total), 'info');
                if (!next) { log(t('readDone', page, ctl.total), 'info'); break; }
                offset = next.offset;
                url = `https://store.steampowered.com/account/licenses/?continuationToken=${next.token}&offset=${next.offset}`;
                await sleep(rand(CFG.pageFetchDelay));
            }
        } finally { ctl.readerDone = true; }
    }

    async function removeGame(packageId) {
        try {
            const response = await fetch('https://store.steampowered.com/account/removelicense', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `sessionid=${encodeURIComponent(g_sessionID)}&packageid=${encodeURIComponent(packageId)}`
            });
            if (response.status === 429) return { success: false, code: 84, error: 'HTTP 429' };
            if (!response.ok) return { success: false, error: `HTTP ${response.status}` };
            const data = await response.json();
            if (data.success === 1) return { success: true };
            return { success: false, code: data.success, error: t('errCode', data.success) };
        } catch (e) { return { success: false, error: e.message }; }
    }

    // raiseGap: only a real error 84 slows the per-deletion pace (minGap).
    function triggerCooldown(reason, raiseGap) {
        const maxMin = Math.max(1, state.coolMaxMin || CFG.coolMaxMin);
        state.coolLevel = Math.min(state.coolLevel + 1, maxMin);
        const startMin = Math.min(maxMin, Math.max(1, state.coolMin || CFG.coolMin));
        const minutes = Math.min(maxMin, startMin + (state.coolLevel - 1) * CFG.coolStepMin);
        let dur = minutes * 60000;
        dur *= 1 + (Math.random() * 2 - 1) * CFG.coolJitter;
        dur = Math.min(maxMin * 60000, Math.max(startMin * 60000, dur));
        state.cooldownUntil = Date.now() + dur;
        state.lastCoolAt = Date.now();
        if (raiseGap) state.minGap = Math.min(CFG.gapMax, Math.max(CFG.gapFirst, Math.round(state.minGap * CFG.gapGrowth)));
        saveState();
        log(t('coolLog', reason, run.sinceLimit, fmtClock(dur), state.coolLevel, Math.round(state.minGap / 1000)), 'warn');
        run.sinceLimit = 0;
        run.okStreak = 0;
    }

    function onSuccess() {
        run.okStreak++;
        run.sinceLimit++;
        run.failStreak = [];
        if (run.okStreak % CFG.coolDecayAfter === 0 && state.coolLevel > 0) state.coolLevel--;
        if (run.okStreak % CFG.gapDecayAfter === 0 && state.minGap > 0) {
            state.minGap = Math.round(state.minGap * CFG.gapDecay);
            if (state.minGap < 1000) state.minGap = 0;
        }
    }

    async function attemptInner(g, ctl) {
        while (run.running) {
            if (!(await honorCooldown())) return 'stop';
            run.current = g.itemName;
            const res = await removeGame(g.packageId);

            if (res.success) {
                onSuccess();
                state.removed++;
                recordDeleted(g);
                natGone(g.packageId);
                run.removedRun++; run.processed++; ctl.finished++;
                run.retry.delete(g.packageId);
                saveState();
                log(t('okLog', g.itemName, g.packageId), 'ok');
                return 'removed';
            }
            if (res.code === 29) {
                addToSkipped(g, true);
                run.skippedRun++; run.processed++; ctl.finished++;
                run.retry.delete(g.packageId);
                saveState();
                log(t('skipLog', g.itemName, g.packageId), 'skip');
                return 'skipped';
            }
            if (res.code === 84) { triggerCooldown(t('reason84'), true); continue; }
            if (res.code === 24) { log(t('err24'), 'err'); run.running = false; return 'stop'; }

            g.attempts = (g.attempts || 0) + 1;
            g.lastErr = res.error;
            run.okStreak = 0;
            run.failStreak.push(g);

            if (run.failStreak.length >= CFG.breakerAfter) {
                run.failStreak.forEach(x => { x.attempts = Math.max(0, x.attempts - 1); });
                run.failStreak = [];
                run.retry.set(g.packageId, g);
                triggerCooldown(t('reasonBreaker', CFG.breakerAfter, res.error), false);
                return 'deferred';
            }
            if (g.attempts >= CFG.maxAttempts) {
                run.gaveUp.set(g.packageId, g);
                run.retry.delete(g.packageId);
                run.processed++; ctl.finished++;
                log(t('gaveLog', g.itemName, g.packageId, g.attempts, res.error), 'err');
                return 'gaveup';
            }
            run.retry.set(g.packageId, g);
            log(t('deferLog', g.itemName, g.packageId, res.error, g.attempts, CFG.maxAttempts), 'warn');
            return 'deferred';
        }
        return 'stop';
    }

    async function attempt(g, ctl) {
        run.cur = g;
        try { return await attemptInner(g, ctl); }
        finally { run.cur = null; }
    }

    async function pace(r) {
        if (!run.running) return;
        let ms;
        if (r === 'deferred' || r === 'gaveup') {
            ms = rand(CFG.failDelay);
        } else {
            const d = state.delaySec * 1000;
            ms = rand([d * 0.6, d * 1.4]) + state.minGap;
        }
        await waitInterruptible(ms);
    }

    async function keepAwake(on) {
        try {
            if (on) {
                if (navigator.wakeLock && !run.wake) run.wake = await navigator.wakeLock.request('screen');
                if (navigator.locks && !run.lockRelease) {
                    navigator.locks.request('slc-keepalive', () => new Promise(res => { run.lockRelease = res; }));
                }
            } else {
                if (run.wake) { await run.wake.release(); run.wake = null; }
                if (run.lockRelease) { run.lockRelease(); run.lockRelease = null; }
            }
        } catch (e) {}
    }
    document.addEventListener('visibilitychange', () => {
        if (run.running && document.visibilityState === 'visible') { run.wake = null; keepAwake(true); }
    });
    window.addEventListener('beforeunload', e => {
        saveDeleted();
        if (run.running) { e.preventDefault(); e.returnValue = ''; }
    });

    // Small dialog with two clearly named choices (a native confirm can only say OK / Cancel).
    // Resolves 'scan', 'go', or null (Esc / click outside).
    function askNoScan() {
        return new Promise(resolve => {
            const ov = document.createElement('div');
            ov.className = 'slc-modal';
            ov.innerHTML = '<div class="slc-dialog" role="dialog"><h3></h3><p></p><div class="slc-dialog-btns">' +
                '<button class="slc-dbtn slc-dgo" data-r="go"></button>' +
                '<button class="slc-dbtn slc-dscan" data-r="scan"></button></div></div>';
            ov.querySelector('h3').textContent = t('noScanTitle');
            ov.querySelector('p').textContent = t('noScanBody');
            ov.querySelector('.slc-dgo').textContent = t('noScanGo');
            ov.querySelector('.slc-dscan').textContent = t('noScanScan');
            const onKey = e => { if (e.key === 'Escape') done(null); };
            const done = r => { document.removeEventListener('keydown', onKey); ov.remove(); resolve(r); };
            ov.addEventListener('click', e => { if (e.target === ov) done(null); });
            ov.querySelectorAll('button').forEach(b => b.addEventListener('click', () => done(b.dataset.r)));
            document.addEventListener('keydown', onKey);
            document.body.appendChild(ov);
            ov.querySelector('.slc-dscan').focus();
        });
    }

    async function runCleaning(skipConfirm) {
        if (run.running) return;

        let allowedSet = null;
        let preQueue = null;
        if (run.scanList.length) {
            const checked = run.scanList.filter(g => g.checked);
            if (!checked.length) { log(t('noSelection'), 'warn'); return; }
            allowedSet = new Set(checked.map(g => g.packageId));
            preQueue = checked.map(g => Object.assign({}, g, { attempts: 0, lastErr: '' }));
        }
        if (!skipConfirm) {
            if (allowedSet) {
                if (!window.confirm(t('confirmCount', allowedSet.size) + t('confirmDelete'))) return;
            } else {
                // Nothing scanned: let the user choose between scanning first and cleaning everything.
                const r = await askNoScan();
                if (r === 'scan') { await scanOnly(); return; }
                if (r !== 'go') return;
            }
        }
        run.allowedSet = allowedSet;

        run.running = true;
        run.last = '';
        run.processed = 0; run.removedRun = 0; run.skippedRun = 0;
        run.startAt = Date.now();
        run.okStreak = 0; run.sinceLimit = 0; run.failStreak = [];
        run.retry.clear();
        run.gaveUp.clear();
        run.tail = [];
        run.preparing = false;
        // Start every run at the configured base delay; only error 84 during this run slows it down.
        state.minGap = 0;
        decayCoolLevel(); // level only survives if the last cooldown was within the last hour
        saveState();
        keepAwake(true);

        if (allowedSet) log(t('startLogChecked', allowedSet.size), 'info');
        else log(t('startLog', state.removed, state.skipped.length), 'info');
        if (state.cooldownUntil > Date.now()) log(t('stillCooling', fmtClock(state.cooldownUntil - Date.now())), 'warn');

        let finishedAll = false;
        try {
            let round = 0;
            while (run.running) {
                round++;
                if (round > 1) log(t('rescan', round), 'info');
                const usePre = round === 1 && preQueue && preQueue.length > 0;
                const queue = run.queue = usePre ? preQueue.slice() : [];
                const ctl = usePre
                    ? { readerDone: true, total: queue.length, finished: 0, pages: 0 }
                    : { readerDone: false, total: 0, finished: 0, pages: 0 };
                run.ctl = ctl;
                run.tail = [];
                run.preparing = false;
                if (usePre) log(t('usingScan', queue.length), 'info');
                else {
                    if (round === 1) { run.nonRemovableList = []; run.nonRemovableSeen = new Set(); }
                    readerTask(queue, ctl);
                }

                while (run.running) {
                    if (!queue.length) {
                        if (!ctl.readerDone) { await sleep(300); continue; }
                        if (run.tail.length) { queue.push(...run.tail); run.tail = []; continue; }
                        break;
                    }
                    const g = queue.shift();
                    const r = await attempt(g, ctl);
                    if (r === 'stop') break;
                    await pace(r);
                }

                let pass = 0;
                while (run.running && run.retry.size) {
                    pass++;
                    log(t('retryStart', run.retry.size, pass), 'info');
                    if (!(await waitInterruptible(CFG.retryPassWait, t('retryWaitLabel')))) break;
                    const items = [...run.retry.values()];
                    run.retry.clear();
                    for (const g of items) {
                        if (!run.running) break;
                        const r = await attempt(g, ctl);
                        if (r === 'stop') break;
                        await pace(r);
                    }
                }
                if (!run.running) break;
                if (ctl.finished === 0) { finishedAll = true; break; }
            }
        } catch (e) { log(t('scriptErr', e && e.message), 'err'); }

        run.last = finishedAll ? 'done' : 'stopped';
        run.running = false;
        run.preparing = false;
        run.tail = [];
        run.scanList = [];
        run.allowedSet = null;
        view.sig = '';
        keepAwake(false);
        saveState();
        saveDeleted();

        log(t('finishLog', finishedAll, run.removedRun, run.skippedRun, run.gaveUp.size, state.removed), finishedAll ? 'ok' : 'info');
        if (run.gaveUp.size) {
            const names = [...run.gaveUp.values()].slice(0, 20).map(x => `${x.itemName}(${x.packageId})`).join(', ');
            log(t('gaveList', names, run.gaveUp.size > 20), 'err');
        }
        render();
    }

    async function scanOnly() {
        if (run.running) return;
        run.allowedSet = null;
        run.running = true;
        run.scanning = true;
        run.last = '';
        run.queue = [];
        run.tail = [];
        run.scanList = [];
        run.nonRemovableList = [];
        run.nonRemovableSeen = new Set();
        const ctl = { readerDone: false, total: 0, finished: 0, pages: 0 };
        run.ctl = ctl;
        log(t('scanStart'), 'info');
        try { await readerTask(run.queue, ctl); }
        catch (e) { log(t('scanErr', e && e.message), 'err'); }
        const completed = run.running;
        run.scanList = run.queue.slice();
        run.queue = [];
        if (completed) {
            const rn = markRisk(run.scanList);
            if (rn > 0) log(t('riskHint', rn), 'warn');
        }
        run.last = completed ? 'scanned' : 'stopped';
        run.running = false;
        run.scanning = false;
        log(completed ? t('scanDone', ctl.total) : t('scanStopped'), completed ? 'ok' : 'info');
        if (completed && run.scanList.length) {
            view.tab = 'pending';
            view.page = 0;
            log(t('scanSwitched'), 'info');
        }
        view.sig = '';
        render();
    }

    function stopCleaning() {
        if (!run.running) return;
        run.running = false;
        log(t('stopReq'), 'info');
    }

    function waitForPage() {
        return new Promise(resolve => {
            if (document.querySelector('.page_content > h2')) return resolve();
            const observer = new MutationObserver(() => {
                if (document.querySelector('.page_content > h2')) {
                    observer.disconnect();
                    resolve();
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
        });
    }
    waitForPage().then(buildUI);
})();
