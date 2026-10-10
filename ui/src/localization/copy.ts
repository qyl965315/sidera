export type Language = 'zh-CN' | 'en';
export type Localized = Record<Language, string>;
export const l = (zh: string, en: string): Localized => ({ 'zh-CN': zh, en });
export const copy = {
    copy: l('复制', 'Copy'), copied: l('已复制', 'Copied'),
    available: l('可用', 'Available'), capabilityIncomplete: l('能力证据不完整', 'Capability evidence incomplete'),
    home: l('首页', 'Home'), projects: l('项目', 'Projects'), attention: l('异常', 'Attention'), nodes: l('节点', 'Nodes'), system: l('控制台', 'Console'),
    activeProjects: l('进行中的项目', 'Active projects'), allProjects: l('项目工作台', 'Project workbench'), goal: l('目标', 'Goal'), tasks: l('任务', 'Tasks'),
    working: l('工作中', 'Working'), waiting: l('等待中', 'Waiting'), completed: l('已完成', 'Completed'), uncertain: l('不确定', 'Uncertain'), error: l('报错', 'Error'),
    mock: l('模拟数据 · 只读预览', 'Mock data · read-only preview'), intro: l('从项目出发，看清当前工作与需要核对的结果。', 'Start with projects. See current work and results needing reconciliation.'),
    detail: l('任务详情', 'Task detail'), who: l('谁在做', 'Assigned Nodes'), parallel: l('并行执行组', 'Parallel execution group'), progress: l('进展与依赖', 'Progress & dependencies'), outputs: l('产出与证据', 'Outputs & evidence'), advanced: l('高级详情', 'Advanced details'),
    estimate: l('约', '≈'), exact: l('精确进度', 'Exact progress'), stateOnly: l('按状态追踪', 'State-only progress'), noReplay: l('外部效果尚未确认；保留原请求与预算预留，等待核对。禁止重发或更换通道重放。', 'External effect is unconfirmed. Retain the original request and budget reservation for reconciliation. Do not resend or replay through another transport.'),
    reviewUnknown: l('尚无独立复核证据', 'No independent review evidence'), errors: l('报错 · 需要处理', 'Errors · action needed'), uncertainty: l('不确定 · 等待核对', 'Uncertain · reconcile'), back: l('返回项目', 'Back to project'),
    effects: l('效果证据', 'Effects'), resources: l('资源', 'Resources'), events: l('事件', 'Events'), connections: l('连接', 'Connections'), internals: l('运行与依赖', 'Runs & dependencies'),
    evidenceNote: l('各项效果独立记录；宿主接收不证明任务完成或人类已读。', 'Effects are recorded independently. Host acceptance does not prove task completion or Human observation.'),
    loading: l('正在读取快照…', 'Reading snapshot…'), unavailable: l('快照不可用，不能据此判断运行状态。', 'Snapshot unavailable; runtime state cannot be inferred.'), blocked: l('未获授权读取；数据与运行状态未知。', 'Read access not authorized; data and runtime state unknown.'), empty: l('暂无项目', 'No projects'), scenario: l('预览场景', 'Preview scenario'), normal: l('正常', 'Normal'), denied: l('读取受阻', 'Read denied'), failed: l('读取失败', 'Read failure'), loadingOption: l('加载中', 'Loading'),
    assignmentCount: l('项节点分配', 'Node assignments'), recent: l('最近进展', 'Recent progress'), canonical: l('内部名称', 'Canonical name'), category: l('类别', 'Category'), noOutputs: l('尚无已确认产出', 'No confirmed outputs'),
} satisfies Record<string, Localized>;
export type CopyKey = keyof typeof copy;
