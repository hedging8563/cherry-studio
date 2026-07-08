import { AGENT_SESSION_STATUS } from '@shared/data/api/schemas/agentSessions'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { createUpdateTimestamps, orderKeyColumns, orderKeyIndex, uuidPrimaryKey } from './_columnHelpers'
import { agentTable } from './agent'
import { agentWorkspaceTable } from './agentWorkspace'

export const agentSessionTable = sqliteTable(
  'agent_session',
  {
    id: uuidPrimaryKey(),
    agentId: text().references(() => agentTable.id, { onDelete: 'set null' }),
    name: text().notNull(),
    // Whether the name was manually edited by user.
    isNameManuallyEdited: integer({ mode: 'boolean' }).notNull().default(false),
    description: text().notNull().default(''),
    workspaceId: text()
      .notNull()
      .references(() => agentWorkspaceTable.id, { onDelete: 'cascade' }),
    traceId: text(),
    // Lifecycle status: 'reserved' rows back a draft prewarm and are hidden from list/search + swept at
    // boot; 'active' is a committed session. See AGENT_SESSION_STATUS.
    status: text().notNull().default(AGENT_SESSION_STATUS.ACTIVE),
    ...orderKeyColumns,
    ...createUpdateTimestamps
  },
  (t) => [orderKeyIndex('agent_session')(t)]
)

export type AgentSessionRow = typeof agentSessionTable.$inferSelect
export type InsertAgentSessionRow = typeof agentSessionTable.$inferInsert
