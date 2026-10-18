import {
  pgTable,
  serial,
  text,
  integer,
  real,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const agents = pgTable("agents", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(), // supervisor | market | graph | memory | synth
  name: text("name").notNull(),
  role: text("role").notNull(),
  callsign: text("callsign").notNull(),
  model: text("model").notNull().default("llama3.1:8b"),
  temperature: real("temperature").notNull().default(0.3),
  systemPrompt: text("system_prompt").notNull(),
  directive: text("directive").notNull().default(""),
  color: text("color").notNull().default("#C6FF4A"),
  tools: text("tools").notNull().default(""), // comma-separated MCP tool names
  runs: integer("runs").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Engine telemetry + agent handoff stream, per chat run. */
export const events = pgTable(
  "events",
  {
    id: serial("id").primaryKey(),
    runId: text("run_id").notNull(),
    sessionId: integer("session_id"),
    agent: text("agent").notNull().default("system"),
    kind: text("kind").notNull().default("system"), // route | tool | handoff | memory | result | error | answer
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("events_run_idx").on(t.runId), index("events_created_idx").on(t.createdAt)],
);

/** Track 2: conversation sessions, per tenant. */
export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: serial("id").primaryKey(),
    tenant: text("tenant").notNull().default("desk-1"),
    title: text("title").notNull().default("New thread"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("sessions_tenant_idx").on(t.tenant)],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // user | assistant
    content: text("content").notNull(),
    sources: jsonb("sources").$type<{ id: string; label: string }[]>(),
    runId: text("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("messages_session_idx").on(t.sessionId)],
);

/**
 * Embedded graph store — FalkorDB compatibility layer.
 * When a FalkorDB server is reachable the driver sends Cypher there;
 * otherwise nodes/edges live here and the same Cypher catalog runs
 * against these tables. Every tenant is scoped.
 */
export const graphNodes = pgTable(
  "graph_nodes",
  {
    id: serial("id").primaryKey(),
    tenant: text("tenant").notNull().default("global"),
    label: text("label").notNull(), // Company | Person | Team | Project | Document | Decision | Quote | Memory | Procedure | Episode
    nodeKey: text("node_key").notNull(), // natural key e.g. Company:AAPL
    props: jsonb("props").$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("gnodes_key_idx").on(t.tenant, t.nodeKey),
    index("gnodes_label_idx").on(t.label),
  ],
);

export const graphEdges = pgTable(
  "graph_edges",
  {
    id: serial("id").primaryKey(),
    tenant: text("tenant").notNull().default("global"),
    src: integer("src").notNull(),
    dst: integer("dst").notNull(),
    type: text("type").notNull(), // COMPETES_WITH | SUPPLIES | IN_SECTOR | OWNS | MEMBER_OF | LEADS | WORKS_ON | AUTHORED | DECIDED | DERIVED_FROM | MENTIONS | HAS_QUOTE | HANDED_TO | RECALLS ...
    props: jsonb("props").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("gedges_src_idx").on(t.src), index("gedges_dst_idx").on(t.dst)],
);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type Agent = typeof agents.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type ChatSession = typeof chatSessions.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type GraphNodeRow = typeof graphNodes.$inferSelect;
export type GraphEdgeRow = typeof graphEdges.$inferSelect;
