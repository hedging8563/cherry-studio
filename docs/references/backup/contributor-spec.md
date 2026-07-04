# Contributor 实现规范摘要（PR Reviewer / Contributor 速读）

> 本文档合成自主架构 `docs/references/backup/backup-architecture.md`（§2/§3.5/§5.4/§6/§6.2/§7/§8.5）与配套 openspec change `modular-backup-contributors-refined` 的 5 源 spec 提取（contributor-framework / registry / backup-service-lifecycle / design / tasks）。**目的**：让 reviewer / contributor 不跨 repo（不读 openspec 完整 spec）即可理解 contributor 体系如何落地（A3 修订后的 placement + lifecycle + 聚合边界 + 不变量 + identity propagation）。

---

## 1. 概述：contributor 体系是什么

备份把"哪个域拥有哪些用户数据表、引用、聚合边界、恢复策略"从集中式规则库（`DomainRegistry`/`DomainStripper`/`DomainImporter`/`FileCollector`，v1 throwaway）下放给各业务域，由每个域声明一个 `BackupContributor`。

**BackupContributor = schema + backupPolicy + operations 三层分离**：

| 层 | 放什么 | 不放什么 |
|---|---|---|
| `schema`（Entity facts） | 表归属、引用事实、主键形态、聚合边界、file-ref source、JSON 软引用 | SET_NULL/DELETE_ROW 动作、导入顺序、恢复策略 |
| `backupPolicy` | 省略引用 override、唯一键合并、列级 FIELD_MERGE（4 strategy 枚举：`remote-fills-local-null` / `remote-fills-local-empty` / `deep-merge` / `local-priority`）、`platformSpecificKeys` | 数据库 I/O、文件操作、异步 hook |
| `operations`（可选） | 文件资源发现、beforeArchive、逐行 transform、afterImport（in detached `work.sqlite`，D 模型）、blob 恢复、cloneAggregate | 可用纯数据表达的事实和策略 |

- contributor 是**冻结的常量对象**（非 class）：`export const TOPICS_CONTRIBUTOR = deepFreeze<BackupContributor>({ domain, schema, backupPolicy, operations })`。理由是纯数据 + 无状态纯函数 hook；`schema-only` 域 `operations: undefined` 天然支持；`deepFreeze` 保证 finalize 后不可变（strict mode 下任何 mutation 抛 TypeError）。
- **核心机制是 `schema.aggregates`（聚合边界 AggregateBoundary）**：把 object-boundary 的 SKIP/OVERWRITE/RENAME 从文字描述提升为**静态可校验**机制——一个 topic 连同它的 message 树、一次 Agent 会话连同它的消息，要么整体导入要么整体跳过。

---

## 2. Placement：contributor 声明放在哪

> 回应 PR #12659 review A3/L289：避免 domain facts 集中到 backup 模块。

**规则**：各域 contributor declaration **co-locate 在该域 owning module 的实际位置**（遵守 main-process 现有目录边界，不强制 `src/main/services/`），由业务域 owner 维护该域 entity facts（表归属/引用/聚合/file-ref/JSON 软引用）。

- 路径：co-locate 在该域 owning module 实际位置。**per-domain 目录**（`<owning>/<domain>/backupContributor.ts`）为默认；**flat owning module**（多域 Service 同目录）SHALL 用 per-domain 子目录（`<dir>/<domain>/backupContributor.ts`）或唯一文件名（`<dir>/backupContributor-<domain>.ts`），避免多域争用同一路径。
- **实际约定**：数据声明（表/列/引用/聚合事实）属 data 层，各 contributor **flat 放在 `src/main/data/services/backupContributor-<domain>.ts`**（避免 backup→business-module 逆向耦合）。两处真实例外：① `src/main/data/backupContributor-preferences.ts`（PREFERENCES 提到 `data/` 上一层）；② `src/main/services/translate/backupContributor.ts`（TRANSLATE_HISTORY 与其业务模块同目录）。
- 位置示例（`features/` / `ai/` 等为**非绑定**的 co-location 示意，数据声明仍按上条归 data 层）：`src/main/data/services/backupContributor-topics.ts`（topics）、`backupContributor-providers.ts`（providers）、`backupContributor-knowledge.ts`（knowledge）、`backupContributor-agents.ts`（AI/agent）。每域可多文件拆分（如 KNOWLEDGE restoreResources 重 IO 可独立文件），测试就近放该域 `__tests__/`。
- **backup 模块只持**：统一 barrel（`contributors/index.ts` 聚合 14 域导出）+ `ContributorManager` + registry + orchestrator。**纯类型 / context 类型 / deepFreeze / dbSchemaRefs / BackupDomain / ConflictStrategy 归 neutral layer**（`@main/data/db/backup/`，见下），backup 与各域 contributor 同向依赖。**不承载任何 domain-specific 表/列/聚合事实**——否则 domain facts 退回集中到 backup 模块，与下放目标矛盾。
- 检查：`src/main/services/backup/contributors/` **SHALL 仅含** barrel（index.ts）/ finalize（ContributorManager）；**SHALL NOT 含** orchestrator（归 `src/main/services/backup/orchestrator/`）/ 纯类型 / context 类型 / deepFreeze（归 neutral layer `@main/data/db/backup/`）/ 域 schema/policy/operations declaration。

**Ownership 边界 + neutral layer**：contributor-consumed 的纯类型 / context 类型 / runtime helper / codegen 产物 / 枚举归 **process-local neutral layer** `@main/data/db/backup/`（data/schema-owned，main-only）：`contributor-types`（BackupContributor/EntityGraphSchema）、`contexts`（BackupScopedDb/hooks context）、`freeze`（deepFreeze）、`dbSchemaRefs`（codegen DB_TABLES/COLUMNS/PK/FK/FTS + 品牌）、`domains`（BackupDomain/ConflictStrategy，main-only——renderer 传简单参数由 BackupService 转换，不 import 枚举）。业务域（topics/agents/...）+ backup service **同向** import 该 neutral layer 声明并导出 contributor——避免 data 域 contributor → services/backup 逆向依赖、shared 层不扩大（dbSchemaRefs/main-only 枚举不放 shared）。**SHALL NOT** 重新定义 `DbTableName`/`DbColumnName` 品牌（从 `@main/data/db/backup/dbSchemaRefs` import）。

> `domain/`（集中式规则库）是 v1 throwaway：contributor 并行实现，等价测试通过后替换 orchestrator import 来源再删 `domain/`，不修其 bug、不加 fallback。

---

## 3. Lifecycle：ContributorManager 如何启动

> 回应 PR #12659 review A3/L304。

**ContributorManager = non-lifecycle named singleton**，对齐 CLAUDE.md「Non-Lifecycle Services 决策指南」：

- 导出：`export const contributorManager = new ContributorManager()`。
- **不** `extends BaseService`、**不**应用 `@Injectable`/`@ServicePhase`、**不**进 `serviceRegistry.ts`、**无** `@DependsOn`。
- 理由：不持有长生命周期资源、**不连 DB**、无 IPC/定时器/事件订阅，只有"启动期一次性 finalize 产出冻结 BackupRegistry"的纯函数式行为。

**惰性 finalize**：`getRegistry()` 首次调用同步 finalize + 深度冻结 + 缓存（幂等）。失败抛 `ContributorFinalizeError`（含 domain/table/owner/违反不变量）。

**触发时机**：`BackupService`（WhenReady lifecycle service）于 `onInit()` 调 `contributorManager.getRegistry()` 惰性触发 finalize——直接 `import { contributorManager }`（**非** `application.get`，因它不在 lifecycle 容器）。失败 → `BackupService.onInit` 失败 → lifecycle 容器拒绝启动并报告。这保留了启动期校验语义，等价于原 `WhenReady + @DependsOn` 方案，但无需把纯静态 finalizer 提升为 lifecycle service。

**finalize 不连 DB**：只读 codegen 产物（`dbSchemaRefs.ts`）+ contributor 声明，不调 `application.get('DbService')`。DB 实际表覆盖由 **coverage test（CI）守门**——finalize 校验声明间一致性，coverage test 校验实际 schema 表覆盖，两者互补。

**BackupService 仍是 lifecycle service**（持 orchestrator / write quiesce 编排 / restore journal 写入 + relaunch 触发等长生命周期资源——D 模型，见 §8；preboot promotion gate 是 db module 导出纯函数，不经 BackupService）：`@Injectable('BackupService') + @ServicePhase(Phase.WhenReady)`。**不** `@DependsOn(['DbService'])`（DbService 是 BeforeReady，phase 顺序自动先于 WhenReady 启动；CLAUDE.md 硬约束：WhenReady 服务不得 `@DependsOn` BeforeReady 服务）。

> **恢复安全（D 模型，对齐 fullex #16714）**：restore 走 **detached merge into `work.sqlite` + preboot atomic promotion**——**永不进程内触碰 live DB**（详见 backup-architecture §9）。BackupService 在运行时只编排 write quiesce（bounded，JobManager + AI streams + Channel + drain in-flight renderer 写，owned by those modules + BackupService 编排）+ `createSnapshot(work.sqlite)` merge base + detached import pipeline + journal 写入 + `application.relaunch()`；preboot promotion gate（`src/main/index.ts` `startApp()` 第一，`initPathRegistry()` 后、`runV2MigrationGate()` 前，separate sibling `restorePromotionGate.ts`）消费窄 journal contract 做 atomic rename promotion + undo（renamed-aside `live.pre-restore-<restoreId>`）。contributor 不负责整库快照与 promotion。**已废弃**（D 模型不需要）：RESTORE BARRIER runtime silence（allowlist + `@WriteSilenceable` + renderer mutation gate）/ `restoreDbFromSnapshot`（runtime 无调用方——无 runtime rollback，pre-relaunch 失败只删 temp）/ `verifyLiveDb`（offline 在 work copy 自跑 + gate 内 post-promotion check）/ onInit recovery gate（preboot 取代）/ `PreferenceService.reloadFromDb` + rebroadcast / `armWriteGate` / `armMutationGate` / `rearmSchedules` / `afterCommit` hook（恢复后重启 cache 自然 fresh load；apply 时无 live writer——PREFERENCES cache 由 `PreferenceService.onInit` fresh load，AGENTS timer 由 `JobManager` startup recovery re-arm）。

> 检查：`serviceRegistry.ts` **SHALL NOT** 含 `ContributorManager`。

---

## 4. 聚合边界 + 26 不变量要点

### 4.1 AggregateBoundary（§6.2 派生公式）

`AggregateBoundary { root, renamable, [identityKey?], [identityClass?], [conflictDefault?], [members?] }`——除 `root` 与 `renamable` 外，其余字段**默认从 `references + primaryKeys` 派生**，contributor 显式声明仅在偏离默认时使用（显式 override 也须与派生自洽，不变量 14 拒绝漂移）。

| 字段 | 缺省派生 | 何时显式声明 |
|------|----------|----------|
| `root` | —（手写，领域事实：哪个表是"对象"语义根） | 必填 |
| `renamable` | —（手写，领域事实：能否安全克隆） | 必填 |
| `identityKey` | `primaryKeys[root].columns`；**root 有 UNIQUE 约束（非 PK）时须含 UNIQUE 键**（防跨设备同值不同 UUID 撞 SQLite UNIQUE，如 `agent_workspace.path`/`tag.name`/`note(rootPath,path)`/`pin(entityType,entityId)`/`agent_global_skill.folderName`/`job_schedule(type,name)`） | PK 复合且 UNIQUE 键非全 PK |
| `identityClass` | `primaryKeys[root].kind`：`uuid-v4`/`uuid-v7`→`uuid-entity`、`natural`/`composite`→`natural-key`；root 有 UNIQUE 约束（非 PK）→ `natural-key` | `slot`（预定义槽位，codegen 无法推断） |
| `conflictDefault` | `uuid-entity`→`SKIP`；`natural-key`/`slot`→`FIELD_MERGE` | 偏离默认时（现网仅 preference/note 偏离为 SKIP，设置类例外，须 reason + 不变量 21） |

> **FIELD_MERGE 列级合并策略**：`fieldMergePolicies` 的 `strategy` 取 **4 枚举**之一（`BackupContributorPolicy` 派生自 backup-architecture §6 policy）：
> - `remote-fills-local-null` — 本地 null 时填远程值；
> - `remote-fills-local-empty` — 本地 null / 空数组 / 默认骨架均视为缺失才填远程（防种子占位致备份凭证被吞）；
> - `deep-merge` — 深度合并对象字段；
> - `local-priority` — 本地非空时本地优先。
>
> **典型**：PROVIDERS `user_provider.apiKeys` / `authConfig` 用 `remote-fills-local-empty`——seeded provider 预置 `apiKeys=[]` 与非空 `authConfig` 骨架，`remote-fills-local-null` 会把它们当作"已有"而静默丢弃备份凭证；`remote-fills-local-empty` 把 `[]` / null / 空-骨架鉴权均视为缺失，保住本地可用 key、补入仅备份持有的 key（§6 "防丢 API key"）。
| `members` | 域内指向 root 的 owning include references 源表（`viaColumn`=ref.column、`parent`=ref target，按拓扑序）；junction 表、跨域 ref、域内指向其它聚合根的 owning ref **不计入** | 需排除默认成员（如 self-ref 自引用） |

`AggregateMember { table, viaColumn, cascade:'include'|'optional' }`：include=随根整体处理；optional=根冲突时仅置空。派生由 `finalize` 启动期完成，**不**在 hook 调用期。

### 4.2 26 不变量要点（§8.5 精炼，非全抄）

每条失败抛 `ContributorFinalizeError(invariantId, payload)`，payload 含 domain/table/sourceType/owner 字段。

**归属与穷尽**：
- #1 每域恰一 contributor（`registry.length===14` 严格相等，`PREFERENCES/PROVIDERS/PROMPTS/MCP_SERVERS/TAGS_GROUPS/ASSISTANTS/AGENTS/SKILLS/MINIAPPS/TOPICS/KNOWLEDGE/TRANSLATE_HISTORY/PAINTINGS/FILE_STORAGE`）。
- #2 每张 Drizzle 用户数据表恰一 owner 或带 reason 排除；#3 无表被多 contributor 拥有；#4/#5 ALWAYS_STRIP/INFRASTRUCTURE/排除集运行时表不被 contributor 拥有（`job_schedule` 不整表排除，`type='agent.task'` row-scope 归 AGENTS）。

**引用与 PK 事实**：
- #6 references 的 source 表（`ref.table`）属声明方 owner，target 可跨域；#7 `omittedReferenceOverrides` 绑定已声明 reference + 非冗余 + reason。
- #8 每个 owned 表恰一个 primary-key fact 且列存在于 codegen；#9 主键 kind 非 ambiguous；#22 主键 kind 非 autoincrement（全库零自增 PK 是无 id remap 的基石前提）。
- #10 references 派生依赖图无环（Kahn 拓扑，环抛 `CircularReferenceError`）；#23 共享表 row-scope 覆盖穷尽 + 未命中 fail-loud（防脏 type 值致数据无声消失）。

**软引用覆盖**：
- #11 每个 `FileRefSourceType` 有 owner 或 runtime-only 排除；#12 声明的 `jsonSoftReferences` 列真实存在且为 json 类型（不反向全库扫描）。

**聚合边界（核心）**：
- #13 aggregate.root 在 owner，identityKey 是其 PK 或业务 UNIQUE 键（防跨设备同值不同 UUID 撞 UNIQUE）；非 PK 的 natural-key/slot identityKey 须由 codegen `DB_UNIQUE_KEYS` 证实真有 UNIQUE 约束，PK-backed identityKey（uuid/自然/复合 PK）豁免。
- #14 aggregate.members 派生自 owning include references——junction 表、跨域 ref、及域内指向**其它聚合根**的 owning ref 均不计入（仅指向本 root 的 owning ref 入 members）；optional 自引用不计入；多 owning reference 指向 member/root 须显式 parent 否则拒绝歧义；parent 链有环拒绝。
- #15 members 中每成员表属于本 contributor、viaColumn 是真实 FK 列指向 root.identityKey 或父 member 的 PK（多层 cascade A→B→C，C.viaColumn→B，§4.1 parent 派生）、junction 表不计入。
- #16 renamable:true 聚合须有 `operations.cloneAggregate`。
- #26 renamable:true 聚合 root PK 须为单列（importer 的 newRootKey 是单值，cloneAggregate 仅替换一个 PK 列；复合 PK renamable 会致 rename 身份损坏，应改 renamable:false）。

**FK 自洽（须 codegen 生成 `DB_FOREIGN_KEYS`）**：
- #19 每个 `EntityReference.kind` 与生成的 FK onDelete 自洽（cascade/restrict→owning 或 junction；set null/no action→optional；set default→拒绝）。
- #20 junction/co-owned FK 不声明 optional，NOT NULL 列不可 SET_NULL。
- #24 声明的 EntityReference 对应生成的 FK；#25 反向——**每个 DB FK 须被 owner contributor 声明**（防漏声明跨域 FK 如 `agent.model→user_model` 致拓扑无依赖边、omitted 动作不触发、悬空 FK 行）。

**冻结与冲突默认**：#17 schema 深度冻结；#18 失败信息含定位字段；#21 natural-key/slot 聚合 conflictDefault 非 SKIP（设置类 preference/note 例外允许 SKIP，含 `platformSpecificKeys` 排除跨平台不兼容 key）。#21 的 `deviation` payload 子类还覆盖 `platformSpecificKeys` scope 校验（仅 PREFERENCES 可声明 + glob 语法合法性）与 `polymorphicEntityMap` 路由值校验（值须为已知 BackupDomain 或 `excluded`）——三者共享 #21 编号、以 `deviation` 字段区分子类。

---

## 5. identity propagation（§5.4）

**场景**：owning/required FK 指向 **natural-key 聚合**（target 按 identityKey FIELD_MERGE、本地 UUID 胜出）时，备份 target 的 UUID 被 FIELD_MERGE 合并掉，importer **必须**建立 `{备份 target id → 本地 canonical id}` 映射，导入 source 时把该 FK 重写到本地 id——否则 owning FK 悬空（`defer_foreign_keys` COMMIT 失败或 source 丢失）。

**重写边界按 ref 是否 required（非按是否 JSON）**：

- **required ref**（target 缺失则功能损坏）——target 合并时**必须重写**：① DB owning FK（`agent_session.workspaceId → agent_workspace`，跨设备同 path 不同 uuid）；② **required JSON ref**（AGENTS：`agent_channel.workspace.workspaceId` / `job_schedule(type='agent.task').jobInputTemplate.workspace.workspaceId`，均为 `AgentSessionWorkspaceSource`），后者由 `jsonSoftReferences` 标 required 类参与 identity propagation——否则恢复看似成功（`foreign_key_check` 通过）但 channel/定时 task 引用悬空 workspace。
- **tolerant ref**（`message.data.fileEntryId` 附件软引用、`chat_message_file_ref` / `painting_file_ref`）——target 合并/缺失时**不重写**，缺失仅降级 Toast + orphan 检测。
- **optional ref**（如 `translate_history.sourceLanguage → translate_language`）——重写保留关联或按 optional 语义 SET_NULL（不可留悬空备份 uuid）。
- **junction ref**（如 `entity_tag.tagId → tag`）——随 root cascade-prune，target 合并时 FK 一并重写。

> **标量 ID 列（无 FK 声明）三分判定**（防"无 FK=悬挂"误判 + 防"指向用户数据必声明 EntityReference"过宽）：
> - 指向**非 DB 资源**（app 内置 preset/常量/目录，如 `knowledge.fileProcessorId`、`userModel.presetModelId`/`userProvider.presetProviderId`/`miniApp.presetMiniAppId`）→ 天然非 EntityReference 候选（无 target 表行），不声明、不重写。
> - 指向 **DB 用户数据 + 有 FK** → 声明 `EntityReference` 走身份传播（不变量 #24/#25 要求声明的 EntityReference 对应生成的 FK）。
> - 指向 **DB 用户数据 + 无 FK**（scalar soft ref，如 `topic.activeNodeId`→message、`painting.providerId/modelId`）→ **不声明 EntityReference**（无 FK，不变量 #24 要求声明须对应 FK）；此类由 `cloneAggregate` 重写（renamable 聚合，如 `activeNodeId` 随克隆映射新 message id）或作 tolerant ref（缺失仅降级，如 painting 软引用）处理。域接受悬空的须域 spec 注 reason（如 PAINTINGS）。
> 「无 FK 声明」≠ 悬挂风险——按"目标是否 DB 资源 + 是否有 FK"三分判定。

> **≠ 已删的 ID remap**：remap 给 uuid-entity 源记录 PK 生成新 uuid（不需要，保留源 PK 幂等）；identity propagation 把源 FK 重定向到 natural-key target 的 canonical id（源记录 PK 不变，natural-key 合并所必需）。

**典型工作流（AGENTS）**：`agent_session.workspaceId → 独立 agent_workspace 聚合`（域内跨聚合 owning reference：同属 AGENTS、分属两个独立聚合根）。workspaceId 是 cascade NOT NULL owning FK，但 target `agent_workspace`（natural-key `path` UNIQUE）是独立聚合根、非 `session.root`——故不变量 14 不计它入 `session.members`、workspace 不强制为 member。这不等于逃避 owning 校验：不变量 25 强制 AGENTS 声明此 FK → 不变量 19 校验 onDelete=cascade 对应 kind=owning 自洽（codegen `DB_FOREIGN_KEYS` 作数据源）。`agent_session` renamable:false（跨聚合 owning 克隆矛盾 + 撞 `path` UNIQUE）。

---

## 5a. 恢复执行模型 + hook 边界（D 模型，对齐 fullex #16714）

> 详见 backup-architecture §9。contributor 只负责**静态事实与合并语义**，恢复执行模型（detached merge + preboot promotion）由 orchestrator + db module gate 承载。

### 执行模型：永不进程内触碰 live DB

restore 走 **D 模型**（detached merge + preboot promotion）——运行时在 detached `work.sqlite` 副本上合并，preboot 原子 rename promotion。**结构性消除** half-restored / WAL sidecar replay / runtime rollback 整类风险。

**运行时（UI 阻塞，BackupService 编排）**：
1. **manifest 版本门禁**（只读归档，**不碰 live DB**）：格式校验 + schema 比对（`schemaMigrationId` 按 `when`(folderMillis) 序），决定 migrate-forward / 直接导入 / 拒绝。migrate-forward 对 `backup.sqlite` 在**独立 better-sqlite3 连接**（非 live `DbService.sqlite`）跑 drizzle `migrate`。
2. **write quiesce**（bounded，旧 RESTORE BARRIER 的严格子集）：pause 三个自主 main-side DB writer —— JobManager（cron / GC / overdue）+ in-flight AI streams / agent turns + inbound channel messages **+ drain in-flight renderer-originated writes**（DataApi mutation / `Preference_Set` IPC —— 阻塞前已 dispatch 的须先排空，否则 snapshot 后落 old live、promotion 时被覆盖丢失）。**无** renderer mutation gate / Preference/DataApi write gate（「无 gate」仅指**新写** gate，restore 启动即**全局阻塞所有 renderer 窗口**（WindowManager，非单窗口 modal）本身即阻新写；恢复后重启 cache 自然 fresh load；apply 时无 live writer）。三个自主 writer 的 quiesce 接口归各模块 own；renderer in-flight drain + 全局窗口阻塞由 BackupService 编排（acquire write-quiet barrier）。
3. **`createSnapshot(work.sqlite)`** —— VACUUM INTO，作 **merge base**（= 当前 live 副本，含 `app_state` / `migration_v2_status`）。
4. **detached import**（独立 better-sqlite3，非 live `DbService.sqlite`）：对 work.sqlite 跑 contributor import pipeline（handle 参数化，detached drizzle；合并语义 SKIP / FIELD_MERGE / only-add 保留）+ **FTS rebuild**（importer 责任，in work.sqlite）+ **offline verification**（integrity_check + foreign_key_check + domain checks + FTS 一致）。不合格的 work.sqlite 永不 promote。
5. **restore journal**（userData sidecar file）写 + per-step write-ahead fsync + `application.relaunch()`（dev mode 不重启 → 提示手动）。

**preboot promotion gate**（`src/main/index.ts` `startApp()` 第一；`application.initPathRegistry()` 后、`await runV2MigrationGate()` 前；**separate sibling `restorePromotionGate.ts`**；db module 导出纯函数，消费窄 journal contract，不知 backup 语义）：校验 `state=='staged'` ∧ **fingerprint** matches ∧ **chainTip** ∈ app bundled chain → checkpoint(TRUNCATE) + close old live → 删 stale -wal/-shm（sidecar hygiene）→ rename live → `live.pre-restore-<restoreId>`（**undo snapshot，zero-copy**）→ rename work → live → **file resources promotion**（按 visibility 序）→ open + integrity_check → journal terminal。**gate never throws**（瞬时失败 → boot old live + report，永不 unbootable）。

**journal contract**（已与 fullex #16714 sync，2026-07-04）：gate condition = **state machine + fingerprint + chainTip**（drop nonce / appVersion / TTL）。
- **state machine**：`staged → promoting → completed/failed/expired`（write-ahead fsync；recovery 看 filesystem reality 幂等 roll forward / back，不盲目 replay = one-shot，故 nonce drop）。
- **fingerprint** = 主 DB 文件 sha256，post `wal_checkpoint(TRUNCATE)`，assert `busy==0 && checkpointed==log`（WAL 下 mtime / size / header counter 都不更新，checkpoint-hash 唯一无 false-match；两边对称）。
- **chainTip** = work.sqlite last applied migration `{ folderMillis, hash }`，gate promote 仅当 app bundled migrations chain **含**此 tip（取代 appVersion equality——drizzle `migrate()` 对 ahead-of-chain 是 silent no-op，version equality 会 false-reject 共享 chain 的 patch 升级）。
- journal 位置 = userData 内 **sidecar file**（非 boot-config：全局 + debounced 无 fsync；非 `app_state`：arbiter 不能在被 arbitrate 的 DB 内，aside rename 会 carry 走）。restore report + undo bookkeeping 进 **work.sqlite 自己的 `app_state`**（原子 promote；同 `migration_v2_status` / seed journal 模式）。

**Undo**：journal { promote: `live.pre-restore-<restoreId>` } + relaunch → 同 gate path（renamed-aside old live = undo snapshot，zero-copy）。undo 是首要价值（merge 不可逆 → undo = 整库 revert）。retention window + GC + 连续 restore 行为待定数字。

**importer 不变量**：merge 保留 `app_state` rows（`migration_v2_status` —— 已在 backup exclusion set，archive 不碰）。work.sqlite = `createSnapshot`(live 副本) 带 `app_state`，promotion 后 migration gate 读 `migration_v2_status=completed` 跳过 —— 结构上不会 re-run v1 import against restored DB。避免对 `app_state` 做 naive `DELETE + re-insert`。

### File resources 按 visibility（关键：并非都 additive）

| 资源 | visibility | 策略 |
|---|---|---|
| File blobs（`Data/Files/{uuid}`） | DB-gated（`file_entry` rows） | **additive-first** 安全（unreferenced blob 不可见，orphan sweep 可 reclaim） |
| KB `{baseId}/` dirs | DB-gated，但 orphanSweep 跳目录（`if (!isFile()) continue`，只扫 `Data/Files`） | additive OK，但 abandoned restore leak 整 dir forever → **journal-driven cleanup** |
| Notes markdown | **非 DB-gated**（notes tree 扫 `feature.notes.path`，用户可指任意 folder；`note` 表只存 starred / expanded） | additive **错**（中断后 .md 全 visible，double-pollution on retry）→ **directory-level near-atomic swap**：rename notesPath aside → move restored tree → adjacent DB rename；undo 反向 |

- **序列**：DB-gated additive → DB rename → Notes dir-swap + destructive overwrites（old renamed aside，undo 必需）→ terminal。Undo 反向。
- **orphanSweep 交互**：`runFileSweep` 检查 non-terminal restore journal 跳过（blob promote 后、DB rename 前，promoted blobs 是 old live orphans；mtime > 5min gate 会过 staging-preserved mtimes）。

### 恢复期 hook 边界（in-tx vs post-tx 严格分离）

恢复期 hook 分两阶段——**in detached work.sqlite，commit 前** vs **（D 模型无 post-tx）**，边界严格分离（符合 §9「detached 写事务 fn 内仅 DB ops」约束 —— 事务 over detached `work.sqlite` handle，**非** live `DbService.withWriteTx`）：

- **`afterImport`（in detached work.sqlite，commit 前）**：在 detached 写事务**内**、commit **之前**执行，只允许依赖已写入 work.sqlite 行的派生操作——主要是 **FTS 重建**（TOPICS 调 `rebuildMessageFts`、AGENTS 调 `rebuildSessionMessageFts`，复用 in-tx 已导入行、重建 FTS5 content table，使其与业务行在同一事务内一致提交）。这是 importer 责任，在 work.sqlite offline 完成，非 live。
  - > **target-state（C-import 待实现）**：上述 detached `afterImport` 是 D 模型目标态。现有 neutral-layer 类型（`src/main/data/db/backup/contexts.ts` 的 `AfterImportContext` / `RestoreResourceContext`）仍是 pre-D-model（`backupDb` + 只读 `liveDb`，无 detached writable handle）——C-import 阶段 SHALL 更新这些类型以暴露 detached `work.sqlite` 写 handle，并把 `liveDb` 语义改为「detached work.sqlite 只读视图」。在 types 更新前，contributor 的 afterImport 实现（FTS rebuild in work.sqlite）缺 handle；故该 hook 的**实现**属 C-import（等 upstream `createSnapshot` / `applyMigrations` / preboot gate 合 main），本期 contributor 仅声明 operations policy。
- **（D 模型无 `afterCommit`）**：live DB 永不进程内写，detached work.sqlite 不持运行时 cache；旧 post-tx 职责（PREFERENCES cache reload / AGENTS `job_schedule` timer re-arm）由 preboot promotion 后**重启**自然完成——PREFERENCES cache 由 `PreferenceService.onInit` fresh load，AGENTS timer 由 `JobManager` startup recovery re-arm。故不再需要 `reloadFromDb` / `rearmSchedulesAfterImport` / `afterCommit` hook。

> **merge 语义不变**：SKIP / FIELD_MERGE / aggregate 冲突 / identity propagation（§5）全部保留，仅 import target 从 live 改为 detached work.sqlite。`pre-snapshot` 保留为 `createSnapshot(work.sqlite)` merge base；journal state machine 的 crash-safety 保留为 preboot promotion gate 的 write-ahead + 幂等 roll forward/back。FTS importer 离线在 work.sqlite 重建（in-tx 一致）。

---

## 6. 各域关键决策（§3.5，14 域）

`identityClass`/默认 `conflictDefault` 为 finalize 派生值，显式声明仅用于偏离默认。

| 域 | 聚合根（+ include 成员） | identityClass | renamable | 默认 conflictDefault | 精简 |
|---|---|---|---|---|---|
| PREFERENCES | `preference[scope,key]` / `note`（`(rootPath,path)` UNIQUE） | natural-key | false | SKIP / SKIP（**设置类例外**：本地优先 + 补缺；`platformSpecificKeys` 排除跨平台不兼容 key） | ✓ |
| PROVIDERS | `user_provider` + `user_model`(providerId) | natural-key | false（派生键） | FIELD_MERGE | ✓ |
| PROMPTS | `prompt` | uuid-entity | false | SKIP | ✓ |
| MCP_SERVERS | `mcp_server` | uuid-entity | false | SKIP | ✓ |
| TAGS_GROUPS | `tag`/`group`/`pin` + `entity_tag`（多态 junction） | tag/pin natural-key、group uuid-entity | false | tag/pin FIELD_MERGE、group SKIP | ✓ |
| ASSISTANTS | `assistant` + `assistant_mcp_server`/`assistant_knowledge_base` | uuid-entity | true | SKIP | ✓ |
| AGENTS | `agent_session`(+`agent_session_message`) / `agent_workspace` / `agent_channel` / `agent` + `job_schedule`(type='agent.task') row-scope + `agent_skill`(junction) | agent_workspace/job_schedule natural-key、其余 uuid-entity | session:false（跨聚合 owning ref）、其余 false | agent_workspace/job_schedule FIELD_MERGE、其余 SKIP | ✓ |
| MINIAPPS | `mini_app`(app_id) | natural-key | false | FIELD_MERGE | ✓ |
| SKILLS | `agent_global_skill`（`folderName` UNIQUE） | natural-key | false | FIELD_MERGE | ✓ |
| TOPICS | `topic` + `message`(topicId) | uuid-entity | true | SKIP | ✓ |
| KNOWLEDGE | `knowledge_base` + `knowledge_item` | uuid-entity | **false**（`{baseId}` 目录一致性难保，RENAME 退化为 SKIP） | SKIP | ✗ |
| TRANSLATE_HISTORY | `translate_language`(langCode) + `translate_history`(uuid-entity 独立聚合) | natural-key / uuid-entity | false | FIELD_MERGE / SKIP | ✗ |
| PAINTINGS | `painting` | uuid-entity | false | SKIP | ✗ |
| FILE_STORAGE | `file_entry` | uuid-entity | false（无安全克隆路径，RENAME 退化为跳过同名不同大小文件） | SKIP | ✗ |

> 精简模式：10 域含、4 域（KNOWLEDGE/TRANSLATE_HISTORY/PAINTINGS/FILE_STORAGE）排除，`includeFiles=false`/`restoreFiles=false`。junction 表（`agent_channel_task`/`agent_skill`）不计入聚合成员，走独立 junction reference。

---

## 7. contributor 声明示例（TOPICS）

聚合根 `topic` + 成员 `message(topicId)`；冲突 → 整组（topic + 其 message 树）按策略处理。

```typescript
import { table } from '@main/data/db/backup/dbSchemaRefs'
import { type BackupContributor } from '@main/data/db/backup/contributor-types'
import { deepFreeze } from '@main/data/db/backup/freeze'

// TOPICS 拥有 topic(uuid-v4) + message(uuid-v7) 两表
// message.topicId→topic.id: 域内 cascade FK → owning include member
// message.modelId→user_model.id: 跨域 set null FK → optional ref (referencedDomain=PROVIDERS)
// message.parentId→message.id: 自引用 set null → optional (self)，不计入聚合成员
export const TOPICS_CONTRIBUTOR = deepFreeze<BackupContributor>({
  domain: 'TOPICS',
  schema: {
    tables: [table('topic'), table('message')],
    references: [
      // owning include ref → member
      // optional cross-domain / self refs
    ],
    primaryKeys: [/* topic: uuid-v4, message: uuid-v7 */],
    aggregates: [{
      root: 'topic',
      renamable: true,
      // identityKey / identityClass / conflictDefault / members 默认从 references+primaryKeys 派生
      // members 默认 = [message (viaColumn=topicId, include)]
    }],
    fileRefSourcePolicies: [
      // chat_message_file_ref → ownerDomain=TOPICS; painting_file_ref → PAINTINGS
      // (post-#16532 拆分：旧多态 file_ref 表已按 source 源域拆为显式 FK 表)
    ],
    jsonSoftReferences: [
      // message.data 含 fileEntryId 软引用 → tolerant
    ]
  },
  backupPolicy: { /* omittedReferenceOverrides / uniqueMergeRules / fieldMergePolicies */ },
  operations: {
    // renamable:true 故 cloneAggregate 必须实现
    // cloneAggregate 须重写 topic.activeNodeId 标量 soft ref 到新 aggregate 的 message id
  }
})
```

> TOPICS `renamable:true`：RENAME 克隆 topic 时 `activeNodeId`（标量 text soft ref 指向 message，无 FK）**必须**随 `cloneAggregate` 重写（映射到新 topic 对应 message 的 id），否则 restored topic 指向旧 aggregate 的节点/悬挂引用——列为该域 `cloneAggregate` 必需重写规则。

---

## 8. 完整 spec 索引（深挖用，标注在配套 openspec change）

下列 spec 文件属于配套实现 spec（openspec change `modular-backup-contributors-refined`，实现期工件、非本 repo git 跟踪）。本文档不引用其路径（避免死链），仅列出职责供深挖。

### 框架与注册（capability `modular-backup-contributor`）
- `proposal.md` — 本变更与 codex 版分歧的裁决（聚合边界、表穷尽归类、稳定主键、omitted 引用派生）。
- `design.md` — 设计基线（三层分离、26 不变量矩阵、coverage、行级合并语义、A3 placement/lifecycle 裁决）。
- `tasks.md` — 实施任务（T0 gate → T1 框架/codegen/registry → T2 14 域 declaration → T3 orchestrator 接入）。
- `specs/modular-backup-contributor/spec.md` — BackupContributor 三层分离 interface 契约。
- `specs/modular-backup-contributor/contributor-framework.md` — contributor 冻结常量对象 + deepFreeze + placement/ownership 边界（A3 修订源）。
- `specs/modular-backup-contributor/types-contracts.md` — `DbTableName`/`DbColumnName<TTable>` 品牌化、helper 签名、codegen 认证路径。
- `specs/modular-backup-contributor/codegen.md` — `generate-backup-schema-refs.ts` 入口与 `backup:refs:generate`/`check` 命令。
- `specs/modular-backup-contributor/registry.md` — `ContributorRegistry` declare module 接口合并 + 14 域穷尽断言 + `ReadonlyBackupRegistry` 只读视图 + ContributorFinalizeError。
- `specs/modular-backup-contributor/hooks.md` — 7 hook 完整 typed context 签名。
- `specs/modular-backup-contributor/contexts.md` — `BackupScopedDb`（drizzle select/insert/update/delete 子集，不暴露 Client/transaction/run）。
- `specs/modular-backup-contributor/contributor-testing.md` — 四层测试（tsc+codegen check / coverage / equivalence / restore tests）。
- `specs/modular-backup-contributor/domains/simple-domains.md` — PROMPTS/MCP_SERVERS/PAINTINGS 等单表/无聚合域 declaration。
- `specs/modular-backup-contributor/domains/config-domains.md` — PROVIDERS/PREFERENCES/TAGS_GROUPS 等配置域（FIELD_MERGE / 设置类 SKIP / platformSpecificKeys）。
- `specs/modular-backup-contributor/domains/aggregate-domains.md` — TOPICS/ASSISTANTS/AGENTS/KNOWLEDGE 等聚合域（renamable、跨聚合 owning ref、row-scope）。

### 恢复安全（capability `backup-restore-safety`）— D 模型
- `specs/backup-restore-safety/spec.md` — capability 级 requirements 汇总。
- `specs/backup-restore-safety/backup-service-lifecycle.md` — BackupService lifecycle（WhenReady；编排放 quiesce / journal / relaunch；preboot promotion gate 是 db module 纯函数不经 BackupService）+ ContributorManager non-lifecycle singleton（A3/L304 修订源）+ IPC channel。
- `specs/backup-restore-safety/export-orchestrator.md` — ExportOrchestrator 5 步流程（VACUUM INTO 复制 → beforeArchive → 收集资源）。
- `specs/backup-restore-safety/import-orchestrator.md` — ImportOrchestrator 流程（聚合边界冲突策略 → defer FK **detached 写事务**（`withDetachedWriteTx`，**非** live `DbService.withWriteTx`）导入到 **detached work.sqlite** → FTS 重建 in work.sqlite → offline verify）。
- `specs/backup-restore-safety/restore-barrier.md` — write quiesce（bounded；3 自主 main-side writer + drain in-flight renderer 写；per-owner pause；旧 RESTORE BARRIER runtime silence 的严格子集）+ restore journal（userData sidecar file；state machine + fingerprint + chainTip contract；crash-safety write-ahead fsync；已与 fullex #16714 sync）+ preboot promotion gate（`src/main/index.ts` `startApp()` 第一，`runV2MigrationGate` 前，separate sibling `restorePromotionGate.ts`；atomic rename promotion + undo + file resources visibility 序）。
- `specs/backup-restore-safety/restore-recovery-point.md` — recovery point 流程（manifest 门禁 → migrate-forward → write quiesce + `createSnapshot(work.sqlite)` merge base → detached import + FTS rebuild + offline verify → journal + relaunch → preboot promotion）。

### 评审记录
- `FINAL_REVIEW.md` — 架构 final review。
- `reviews/PR12659-v2-lead-review.md` — PR #12659 review（A3 placement/lifecycle 修订出处）。
- `reviews/D-group-decision-summary.md` — 分歧裁决汇总。

> 主架构对照文档：`docs/references/backup/backup-architecture.md`（本 repo 内，详尽论述；本文档为其 contributor 落地要点的精炼速读版）。
