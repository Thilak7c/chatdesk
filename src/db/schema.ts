// src/db/schema.ts
//
// Single source of truth for the database. `npm run db:generate`
// turns changes here into SQL under ./drizzle; `npm run db:migrate`
// applies them.
//
// Tenancy: every business row carries `account_id`. Postgres does
// not enforce row-level isolation — every query MUST filter by the
// caller's account (see src/lib/auth/account.ts). Business rules
// that used to live in SQL functions/triggers now live in
// src/lib/** service modules.

import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  integer,
  real,
  numeric,
  timestamp,
  jsonb,
  date,
  vector,
  customType,
  uniqueIndex,
  index,
  unique,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

/** `created_at` with a NOT NULL default of now(). */
const createdAt = () =>
  timestamp("created_at", { withTimezone: true, precision: 3 }).defaultNow().notNull();

/** `updated_at` that Drizzle bumps on every UPDATE it issues. */
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, precision: 3 })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date());

/**
 * CHECK (col IN (...)) helper for text "enum" columns. Values are
 * inlined as literals (DDL can't take bind parameters) — only ever
 * pass constants here.
 */
const oneOf = (col: AnyPgColumn, values: readonly string[]) =>
  sql`${col} in (${sql.raw(values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", "))})`;

// ============================================================
// ENUMS
// ============================================================
export const accountRoleEnum = pgEnum("account_role_enum", [
  "owner",
  "admin",
  "agent",
  "viewer",
]);

// ============================================================
// AUTH: USERS, SESSIONS, PASSWORD RESETS
// ============================================================
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  createdAt: createdAt(),
});

// Database-backed login sessions. The browser holds a random token;
// only its SHA-256 hash is stored, so a DB leak can't be replayed.
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, precision: 3 }).notNull(),
  },
  (t) => [index("idx_sessions_user").on(t.userId)],
);

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true, precision: 3 }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true, precision: 3 }),
  },
  (t) => [index("idx_password_reset_tokens_user").on(t.userId)],
);

// ============================================================
// ACCOUNTS
// ============================================================
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    defaultCurrency: text("default_currency").notNull().default("USD"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("idx_accounts_one_per_owner").on(t.ownerUserId),
    check("accounts_default_currency_check", sql`${t.defaultCurrency} ~ '^[A-Z]{3}$'`),
  ],
);

export const accountInvitations = pgTable(
  "account_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    role: accountRoleEnum("role").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    label: text("label"),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true, precision: 3 }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, precision: 3 }),
    acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    index("idx_account_invitations_account_pending")
      .on(t.accountId, t.expiresAt)
      .where(sql`${t.acceptedAt} is null`),
    check("account_invitations_role_check", sql`${t.role} <> 'owner'`),
  ],
);

// ============================================================
// PROFILES — one per user; carries the user's account + role.
// ============================================================
export const profiles = pgTable(
  "profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    accountRole: accountRoleEnum("account_role").notNull(),
    fullName: text("full_name").notNull(),
    email: text("email").notNull(),
    avatarUrl: text("avatar_url"),
    role: text("role").default("user"),
    betaFeatures: text("beta_features").array().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("idx_profiles_account_role").on(t.accountId, t.accountRole)],
);

// ============================================================
// CONTACTS
// ============================================================
export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    phone: text("phone").notNull(),
    // Digits-only phone, used for dedup. Computed by Postgres.
    phoneNormalized: text("phone_normalized").generatedAlwaysAs(
      sql`regexp_replace(phone, '\\D', '', 'g')`,
    ),
    name: text("name"),
    email: text("email"),
    company: text("company"),
    avatarUrl: text("avatar_url"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("idx_contacts_account_phone_normalized")
      .on(t.accountId, t.phoneNormalized)
      .where(sql`${t.phoneNormalized} <> ''`),
    index("idx_contacts_account").on(t.accountId),
    index("idx_contacts_phone").on(t.phone),
  ],
);

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("#3b82f6"),
    createdAt: createdAt(),
  },
  (t) => [index("idx_tags_account").on(t.accountId)],
);

export const contactTags = pgTable(
  "contact_tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("contact_tags_contact_id_tag_id_key").on(t.contactId, t.tagId),
    index("idx_contact_tags_tag").on(t.tagId),
  ],
);

export const customFields = pgTable(
  "custom_fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    fieldName: text("field_name").notNull(),
    fieldType: text("field_type").notNull().default("text"),
    fieldOptions: jsonb("field_options"),
    createdAt: createdAt(),
  },
  (t) => [index("idx_custom_fields_account").on(t.accountId)],
);

export const contactCustomValues = pgTable(
  "contact_custom_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    customFieldId: uuid("custom_field_id")
      .notNull()
      .references(() => customFields.id, { onDelete: "cascade" }),
    value: text("value"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("contact_custom_values_contact_id_custom_field_id_key").on(
      t.contactId,
      t.customFieldId,
    ),
  ],
);

export const contactNotes = pgTable(
  "contact_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    noteText: text("note_text").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("idx_contact_notes_account").on(t.accountId),
    index("idx_contact_notes_contact").on(t.contactId),
  ],
);

// ============================================================
// CONVERSATIONS + MESSAGES
// ============================================================
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("open"),
    // users.id of the assigned agent (no FK — a removed member just
    // leaves a dangling id that the UI renders as "unassigned").
    assignedAgentId: uuid("assigned_agent_id"),
    lastMessageText: text("last_message_text"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true, precision: 3 }),
    unreadCount: integer("unread_count").notNull().default(0),
    aiAutoreplyDisabled: boolean("ai_autoreply_disabled").notNull().default(false),
    aiReplyCount: integer("ai_reply_count").notNull().default(0),
    aiHandoffSummary: text("ai_handoff_summary"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("idx_conversations_account_contact").on(t.accountId, t.contactId),
    index("idx_conversations_contact_id").on(t.contactId),
    index("idx_conversations_account_last_message").on(
      t.accountId,
      t.lastMessageAt.desc(),
    ),
    check(
      "conversations_status_check",
      oneOf(t.status, ["open", "pending", "closed"]),
    ),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    senderType: text("sender_type").notNull(),
    senderId: uuid("sender_id"),
    contentType: text("content_type").notNull().default("text"),
    contentText: text("content_text"),
    mediaUrl: text("media_url"),
    mediaType: text("media_type"),
    templateName: text("template_name"),
    // WhatsApp message id (wamid).
    messageId: text("message_id"),
    status: text("status").notNull().default("sent"),
    replyToMessageId: uuid("reply_to_message_id").references(
      (): AnyPgColumn => messages.id,
      { onDelete: "set null" },
    ),
    interactiveReplyId: text("interactive_reply_id"),
    interactivePayload: jsonb("interactive_payload"),
    aiGenerated: boolean("ai_generated").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("idx_messages_conversation_message_id").on(
      t.conversationId,
      t.messageId,
    ),
    index("idx_messages_conversation_created").on(t.conversationId, t.createdAt),
    index("idx_messages_message_id").on(t.messageId),
    index("idx_messages_reply_to")
      .on(t.replyToMessageId)
      .where(sql`${t.replyToMessageId} is not null`),
    check(
      "messages_sender_type_check",
      oneOf(t.senderType, ["customer", "agent", "bot"]),
    ),
    check(
      "messages_content_type_check",
      oneOf(t.contentType, [
        "text",
        "image",
        "document",
        "audio",
        "video",
        "location",
        "template",
        "interactive",
      ]),
    ),
    check(
      "messages_status_check",
      oneOf(t.status, ["sending", "sent", "delivered", "read", "failed"]),
    ),
  ],
);

export const messageReactions = pgTable(
  "message_reactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    actorType: text("actor_type").notNull(),
    actorId: uuid("actor_id"),
    emoji: text("emoji").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("message_reactions_msg_actor_unique").on(
      t.messageId,
      t.actorType,
      t.actorId,
    ),
    index("idx_message_reactions_conversation").on(t.conversationId),
    check(
      "message_reactions_actor_type_check",
      oneOf(t.actorType, ["customer", "agent"]),
    ),
  ],
);

// ============================================================
// WHATSAPP CONFIG + TEMPLATES
// ============================================================
export const whatsappConfig = pgTable(
  "whatsapp_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .unique()
      .references(() => accounts.id, { onDelete: "cascade" }),
    phoneNumberId: text("phone_number_id").notNull().unique(),
    wabaId: text("waba_id"),
    // Encrypted at rest (src/lib/whatsapp/encryption.ts).
    accessToken: text("access_token").notNull(),
    verifyToken: text("verify_token"),
    status: text("status").notNull().default("disconnected"),
    connectedAt: timestamp("connected_at", { withTimezone: true, precision: 3 }),
    registeredAt: timestamp("registered_at", { withTimezone: true, precision: 3 }),
    subscribedAppsAt: timestamp("subscribed_apps_at", { withTimezone: true, precision: 3 }),
    lastRegistrationError: text("last_registration_error"),
    mirrorInboundMedia: boolean("mirror_inbound_media").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "whatsapp_config_status_check",
      oneOf(t.status, ["connected", "disconnected"]),
    ),
  ],
);

export const messageTemplates = pgTable(
  "message_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    category: text("category").notNull().default("Marketing"),
    language: text("language").notNull().default("en_US"),
    headerType: text("header_type"),
    headerContent: text("header_content"),
    bodyText: text("body_text").notNull(),
    footerText: text("footer_text"),
    buttons: jsonb("buttons"),
    status: text("status").notNull().default("DRAFT"),
    sampleValues: jsonb("sample_values"),
    metaTemplateId: text("meta_template_id"),
    rejectionReason: text("rejection_reason"),
    qualityScore: text("quality_score"),
    headerHandle: text("header_handle"),
    headerMediaUrl: text("header_media_url"),
    submissionError: text("submission_error"),
    lastSubmittedAt: timestamp("last_submitted_at", { withTimezone: true, precision: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One template per (account, name, language) — Meta's own key
    // within a WABA, so teammates can't shadow each other.
    unique("message_templates_account_name_language_key").on(
      t.accountId,
      t.name,
      t.language,
    ),
    index("idx_message_templates_meta_template_id")
      .on(t.metaTemplateId)
      .where(sql`${t.metaTemplateId} is not null`),
    check(
      "message_templates_category_check",
      oneOf(t.category, ["Marketing", "Utility", "Authentication"]),
    ),
    check(
      "message_templates_header_type_check",
      oneOf(t.headerType, ["text", "image", "video", "document"]),
    ),
    check(
      "message_templates_status_check",
      oneOf(t.status, [
        "DRAFT",
        "PENDING",
        "APPROVED",
        "REJECTED",
        "PAUSED",
        "DISABLED",
        "IN_APPEAL",
        "PENDING_DELETION",
      ]),
    ),
    check(
      "message_templates_quality_score_check",
      sql`${t.qualityScore} is null or ${oneOf(t.qualityScore, ["GREEN", "YELLOW", "RED"])}`,
    ),
    check(
      "message_templates_buttons_check",
      sql`${t.buttons} is null or (jsonb_typeof(${t.buttons}) = 'array' and jsonb_array_length(${t.buttons}) <= 10)`,
    ),
  ],
);

export const quickReplies = pgTable(
  "quick_replies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    kind: text("kind").notNull().default("text"),
    contentText: text("content_text"),
    interactivePayload: jsonb("interactive_payload"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("idx_quick_replies_account").on(t.accountId),
    check("quick_replies_kind_check", oneOf(t.kind, ["text", "interactive"])),
  ],
);

// ============================================================
// PIPELINES + DEALS
// ============================================================
export const pipelines = pgTable(
  "pipelines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("idx_pipelines_account").on(t.accountId)],
);

export const pipelineStages = pgTable(
  "pipeline_stages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pipelineId: uuid("pipeline_id")
      .notNull()
      .references(() => pipelines.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    color: text("color").notNull().default("#3b82f6"),
    createdAt: createdAt(),
  },
  (t) => [index("idx_pipeline_stages_pipeline").on(t.pipelineId)],
);

export const deals = pgTable(
  "deals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    pipelineId: uuid("pipeline_id")
      .notNull()
      .references(() => pipelines.id, { onDelete: "cascade" }),
    stageId: uuid("stage_id")
      .notNull()
      .references(() => pipelineStages.id),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    // profiles.id (not users.id) of the assignee.
    assignedTo: uuid("assigned_to").references(() => profiles.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    value: numeric("value", { precision: 12, scale: 2 }).notNull().default("0"),
    currency: text("currency").notNull().default("USD"),
    notes: text("notes"),
    expectedCloseDate: date("expected_close_date"),
    status: text("status").notNull().default("open"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("idx_deals_account").on(t.accountId),
    index("idx_deals_pipeline").on(t.pipelineId),
    index("idx_deals_stage").on(t.stageId),
    index("idx_deals_assigned_to").on(t.assignedTo),
    check("deals_status_check", oneOf(t.status, ["open", "won", "lost"])),
  ],
);

// ============================================================
// BROADCASTS
// ============================================================
export const broadcasts = pgTable(
  "broadcasts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    templateName: text("template_name").notNull(),
    templateLanguage: text("template_language").notNull().default("en_US"),
    templateVariables: jsonb("template_variables"),
    audienceFilter: jsonb("audience_filter"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true, precision: 3 }),
    status: text("status").notNull().default("draft"),
    // Aggregates over broadcast_recipients, maintained by
    // src/lib/broadcasts/counters.ts in the same transaction as the
    // recipient status change.
    totalRecipients: integer("total_recipients").notNull().default(0),
    sentCount: integer("sent_count").notNull().default(0),
    deliveredCount: integer("delivered_count").notNull().default(0),
    readCount: integer("read_count").notNull().default(0),
    repliedCount: integer("replied_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    deliveryLockedAt: timestamp("delivery_locked_at", { withTimezone: true, precision: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("idx_broadcasts_account").on(t.accountId),
    index("idx_broadcasts_scheduled_due")
      .on(t.scheduledAt)
      .where(sql`${t.status} = 'scheduled'`),
    check(
      "broadcasts_status_check",
      oneOf(t.status, ["draft", "scheduled", "sending", "sent", "failed"]),
    ),
  ],
);

export const broadcastRecipients = pgTable(
  "broadcast_recipients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    broadcastId: uuid("broadcast_id")
      .notNull()
      .references(() => broadcasts.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("pending"),
    sentAt: timestamp("sent_at", { withTimezone: true, precision: 3 }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true, precision: 3 }),
    readAt: timestamp("read_at", { withTimezone: true, precision: 3 }),
    repliedAt: timestamp("replied_at", { withTimezone: true, precision: 3 }),
    errorMessage: text("error_message"),
    whatsappMessageId: text("whatsapp_message_id"),
    templateParams: jsonb("template_params"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("idx_broadcast_recipients_wamid")
      .on(t.whatsappMessageId)
      .where(sql`${t.whatsappMessageId} is not null`),
    index("idx_broadcast_recipients_broadcast_status").on(t.broadcastId, t.status),
    check(
      "broadcast_recipients_status_check",
      oneOf(t.status, ["pending", "sent", "delivered", "read", "replied", "failed"]),
    ),
  ],
);

// ============================================================
// AUTOMATIONS
// ============================================================
export const automations = pgTable(
  "automations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    triggerType: text("trigger_type").notNull(),
    triggerConfig: jsonb("trigger_config").notNull().default({}),
    isActive: boolean("is_active").notNull().default(false),
    executionCount: integer("execution_count").notNull().default(0),
    lastExecutedAt: timestamp("last_executed_at", { withTimezone: true, precision: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("idx_automations_account").on(t.accountId),
    index("idx_automations_account_active_trigger")
      .on(t.accountId, t.triggerType)
      .where(sql`${t.isActive} = true`),
  ],
);

export const automationSteps = pgTable(
  "automation_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    parentStepId: uuid("parent_step_id").references(
      (): AnyPgColumn => automationSteps.id,
      { onDelete: "cascade" },
    ),
    branch: text("branch"),
    stepType: text("step_type").notNull(),
    stepConfig: jsonb("step_config").notNull().default({}),
    position: integer("position").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("idx_automation_steps_automation_id").on(t.automationId, t.position),
    index("idx_automation_steps_parent")
      .on(t.parentStepId)
      .where(sql`${t.parentStepId} is not null`),
    check("automation_steps_branch_check", oneOf(t.branch, ["yes", "no"])),
  ],
);

export const automationLogs = pgTable(
  "automation_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    triggerEvent: text("trigger_event").notNull(),
    stepsExecuted: jsonb("steps_executed").notNull().default([]),
    status: text("status").notNull(),
    errorMessage: text("error_message"),
    createdAt: createdAt(),
  },
  (t) => [
    index("idx_automation_logs_account").on(t.accountId),
    index("idx_automation_logs_automation").on(t.automationId, t.createdAt.desc()),
    check(
      "automation_logs_status_check",
      oneOf(t.status, ["success", "partial", "failed"]),
    ),
  ],
);

export const automationPendingExecutions = pgTable(
  "automation_pending_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    logId: uuid("log_id").references(() => automationLogs.id, {
      onDelete: "cascade",
    }),
    parentStepId: uuid("parent_step_id").references(() => automationSteps.id, {
      onDelete: "set null",
    }),
    branch: text("branch"),
    nextStepPosition: integer("next_step_position").notNull(),
    context: jsonb("context").notNull().default({}),
    status: text("status").notNull().default("pending"),
    runAt: timestamp("run_at", { withTimezone: true, precision: 3 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("idx_automation_pending_due")
      .on(t.runAt)
      .where(sql`${t.status} = 'pending'`),
    index("idx_automation_pending_account").on(t.accountId),
    check(
      "automation_pending_executions_branch_check",
      oneOf(t.branch, ["yes", "no"]),
    ),
    check(
      "automation_pending_executions_status_check",
      oneOf(t.status, ["pending", "running", "done", "failed"]),
    ),
  ],
);

// ============================================================
// FLOWS
// ============================================================
export const flows = pgTable(
  "flows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("draft"),
    triggerType: text("trigger_type").notNull(),
    triggerConfig: jsonb("trigger_config").notNull().default({}),
    entryNodeId: text("entry_node_id"),
    fallbackPolicy: jsonb("fallback_policy").notNull().default({
      on_unknown_reply: "reprompt",
      max_reprompts: 2,
      on_timeout_hours: 24,
      on_exhaust: "handoff",
    }),
    executionCount: integer("execution_count").notNull().default(0),
    lastExecutedAt: timestamp("last_executed_at", { withTimezone: true, precision: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("idx_flows_account").on(t.accountId),
    index("idx_flows_account_active_trigger")
      .on(t.accountId, t.triggerType)
      .where(sql`${t.status} = 'active'`),
    check("flows_status_check", oneOf(t.status, ["draft", "active", "archived"])),
    check(
      "flows_trigger_type_check",
      oneOf(t.triggerType, ["keyword", "first_inbound_message", "manual"]),
    ),
  ],
);

export const flowNodes = pgTable(
  "flow_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flowId: uuid("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    nodeKey: text("node_key").notNull(),
    nodeType: text("node_type").notNull(),
    config: jsonb("config").notNull().default({}),
    positionX: integer("position_x").notNull().default(0),
    positionY: integer("position_y").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    unique("flow_nodes_flow_id_node_key_key").on(t.flowId, t.nodeKey),
    check(
      "flow_nodes_node_type_check",
      oneOf(t.nodeType, [
        "start",
        "send_buttons",
        "send_list",
        "send_message",
        "send_media",
        "collect_input",
        "condition",
        "set_tag",
        "handoff",
        "http_fetch",
        "end",
      ]),
    ),
  ],
);

export const flowRuns = pgTable(
  "flow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flowId: uuid("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("active"),
    currentNodeKey: text("current_node_key"),
    lastPromptMessageId: uuid("last_prompt_message_id").references(
      () => messages.id,
      { onDelete: "set null" },
    ),
    vars: jsonb("vars").notNull().default({}),
    repromptCount: integer("reprompt_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true, precision: 3 }).defaultNow().notNull(),
    lastAdvancedAt: timestamp("last_advanced_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true, precision: 3 }),
    endReason: text("end_reason"),
  },
  (t) => [
    index("idx_flow_runs_account").on(t.accountId),
    index("idx_flow_runs_active_advanced")
      .on(t.lastAdvancedAt)
      .where(sql`${t.status} = 'active'`),
    index("idx_flow_runs_flow_started").on(t.flowId, t.startedAt.desc()),
    // At most one active run per contact — the engine relies on
    // this to resolve "which flow does this reply belong to".
    uniqueIndex("idx_one_active_run_per_contact")
      .on(t.accountId, t.contactId)
      .where(sql`${t.status} = 'active'`),
    check(
      "flow_runs_status_check",
      oneOf(t.status, [
        "active",
        "completed",
        "handed_off",
        "timed_out",
        "paused_by_agent",
        "failed",
      ]),
    ),
  ],
);

export const flowRunEvents = pgTable(
  "flow_run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flowRunId: uuid("flow_run_id")
      .notNull()
      .references(() => flowRuns.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    nodeKey: text("node_key"),
    payload: jsonb("payload").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("idx_flow_run_events_run_time").on(t.flowRunId, t.createdAt.desc()),
    check(
      "flow_run_events_event_type_check",
      oneOf(t.eventType, [
        "started",
        "node_entered",
        "message_sent",
        "reply_received",
        "fallback_fired",
        "handoff",
        "timeout",
        "error",
        "completed",
      ]),
    ),
  ],
);

// ============================================================
// PRESENCE
// ============================================================
export const memberPresence = pgTable(
  "member_presence",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("online"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("member_presence_account_idx").on(t.accountId),
    check("member_presence_status_check", oneOf(t.status, ["online", "away"])),
  ],
);

// ============================================================
// API KEYS + WEBHOOKS
// ============================================================
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    scopes: text("scopes").array().notNull().default([]),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, precision: 3 }),
    expiresAt: timestamp("expires_at", { withTimezone: true, precision: 3 }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, precision: 3 }),
    createdAt: createdAt(),
  },
  (t) => [index("api_keys_account_id_idx").on(t.accountId)],
);

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    url: text("url").notNull(),
    secret: text("secret").notNull(),
    events: text("events").array().notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true, precision: 3 }),
    failureCount: integer("failure_count").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("webhook_endpoints_account_id_idx").on(t.accountId)],
);

// ============================================================
// NOTIFICATIONS
// ============================================================
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull().default("conversation_assigned"),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "cascade",
    }),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    body: text("body"),
    readAt: timestamp("read_at", { withTimezone: true, precision: 3 }),
    createdAt: createdAt(),
  },
  (t) => [
    index("idx_notifications_user_created").on(t.userId, t.createdAt.desc()),
    index("idx_notifications_user_unread")
      .on(t.userId)
      .where(sql`${t.readAt} is null`),
    check("notifications_type_check", oneOf(t.type, ["conversation_assigned"])),
  ],
);

// ============================================================
// AI: CONFIG, KNOWLEDGE, USAGE
// ============================================================
export const aiConfigs = pgTable(
  "ai_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .unique()
      .references(() => accounts.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    // Encrypted at rest.
    apiKey: text("api_key").notNull(),
    embeddingsApiKey: text("embeddings_api_key"),
    systemPrompt: text("system_prompt"),
    isActive: boolean("is_active").notNull().default(false),
    autoReplyEnabled: boolean("auto_reply_enabled").notNull().default(false),
    autoReplyMaxPerConversation: integer("auto_reply_max_per_conversation")
      .notNull()
      .default(3),
    handoffAgentId: uuid("handoff_agent_id").references(() => users.id, {
      onDelete: "set null",
    }),
    confidenceThreshold: real("confidence_threshold"),
    hardEscalateKeywords: jsonb("hard_escalate_keywords").notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("ai_configs_provider_check", oneOf(t.provider, ["openai", "anthropic"])),
    check(
      "ai_configs_auto_reply_max_check",
      sql`${t.autoReplyMaxPerConversation} between 1 and 20`,
    ),
  ],
);

export const aiKnowledgeDocuments = pgTable(
  "ai_knowledge_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    content: text("content").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("ai_knowledge_documents_account_id_idx").on(t.accountId)],
);

export const aiKnowledgeChunks = pgTable(
  "ai_knowledge_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => aiKnowledgeDocuments.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull().default(0),
    content: text("content").notNull(),
    fts: tsvector("fts").generatedAlwaysAs(sql`to_tsvector('simple', content)`),
    embedding: vector("embedding", { dimensions: 1536 }),
    createdAt: createdAt(),
  },
  (t) => [
    index("ai_knowledge_chunks_account_id_idx").on(t.accountId),
    index("ai_knowledge_chunks_document_id_idx").on(t.documentId),
    index("ai_knowledge_chunks_fts_idx").using("gin", t.fts),
    index("ai_knowledge_chunks_embedding_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
  ],
);

export const aiUsageLog = pgTable(
  "ai_usage_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    mode: text("mode").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index("idx_ai_usage_log_account_created").on(t.accountId, t.createdAt.desc()),
    check("ai_usage_log_mode_check", oneOf(t.mode, ["auto_reply", "draft"])),
    check("ai_usage_log_provider_check", oneOf(t.provider, ["openai", "anthropic"])),
  ],
);
