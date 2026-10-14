CREATE TYPE "public"."account_role_enum" AS ENUM('owner', 'admin', 'agent', 'viewer');--> statement-breakpoint
CREATE TABLE "account_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"role" "account_role_enum" NOT NULL,
	"created_by_user_id" uuid,
	"label" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"accepted_at" timestamp (3) with time zone,
	"accepted_by_user_id" uuid,
	CONSTRAINT "account_invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "account_invitations_role_check" CHECK ("account_invitations"."role" <> 'owner')
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"default_currency" text DEFAULT 'USD' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_default_currency_check" CHECK ("accounts"."default_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "ai_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"created_by" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"api_key" text NOT NULL,
	"embeddings_api_key" text,
	"system_prompt" text,
	"is_active" boolean DEFAULT false NOT NULL,
	"auto_reply_enabled" boolean DEFAULT false NOT NULL,
	"auto_reply_max_per_conversation" integer DEFAULT 3 NOT NULL,
	"handoff_agent_id" uuid,
	"confidence_threshold" real,
	"hard_escalate_keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_configs_account_id_unique" UNIQUE("account_id"),
	CONSTRAINT "ai_configs_provider_check" CHECK ("ai_configs"."provider" in ('openai', 'anthropic')),
	CONSTRAINT "ai_configs_auto_reply_max_check" CHECK ("ai_configs"."auto_reply_max_per_conversation" between 1 and 20)
);
--> statement-breakpoint
CREATE TABLE "ai_knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"content" text NOT NULL,
	"fts" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
	"embedding" vector(1536),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_knowledge_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"created_by" uuid,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"conversation_id" uuid,
	"mode" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_log_mode_check" CHECK ("ai_usage_log"."mode" in ('auto_reply', 'draft')),
	CONSTRAINT "ai_usage_log_provider_check" CHECK ("ai_usage_log"."provider" in ('openai', 'anthropic'))
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"created_by" uuid,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"last_used_at" timestamp (3) with time zone,
	"expires_at" timestamp (3) with time zone,
	"revoked_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "automation_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid,
	"trigger_event" text NOT NULL,
	"steps_executed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"error_message" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_logs_status_check" CHECK ("automation_logs"."status" in ('success', 'partial', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "automation_pending_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid,
	"log_id" uuid,
	"parent_step_id" uuid,
	"branch" text,
	"next_step_position" integer NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"run_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_pending_executions_branch_check" CHECK ("automation_pending_executions"."branch" in ('yes', 'no')),
	CONSTRAINT "automation_pending_executions_status_check" CHECK ("automation_pending_executions"."status" in ('pending', 'running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "automation_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"parent_step_id" uuid,
	"branch" text,
	"step_type" text NOT NULL,
	"step_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_steps_branch_check" CHECK ("automation_steps"."branch" in ('yes', 'no'))
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"trigger_type" text NOT NULL,
	"trigger_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"execution_count" integer DEFAULT 0 NOT NULL,
	"last_executed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broadcast_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"contact_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp (3) with time zone,
	"delivered_at" timestamp (3) with time zone,
	"read_at" timestamp (3) with time zone,
	"replied_at" timestamp (3) with time zone,
	"error_message" text,
	"whatsapp_message_id" text,
	"template_params" jsonb,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "broadcast_recipients_status_check" CHECK ("broadcast_recipients"."status" in ('pending', 'sent', 'delivered', 'read', 'replied', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "broadcasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"template_name" text NOT NULL,
	"template_language" text DEFAULT 'en_US' NOT NULL,
	"template_variables" jsonb,
	"audience_filter" jsonb,
	"scheduled_at" timestamp (3) with time zone,
	"status" text DEFAULT 'draft' NOT NULL,
	"total_recipients" integer DEFAULT 0 NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"delivered_count" integer DEFAULT 0 NOT NULL,
	"read_count" integer DEFAULT 0 NOT NULL,
	"replied_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"delivery_locked_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "broadcasts_status_check" CHECK ("broadcasts"."status" in ('draft', 'scheduled', 'sending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "contact_custom_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"custom_field_id" uuid NOT NULL,
	"value" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_custom_values_contact_id_custom_field_id_key" UNIQUE("contact_id","custom_field_id")
);
--> statement-breakpoint
CREATE TABLE "contact_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"note_text" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_tags_contact_id_tag_id_key" UNIQUE("contact_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"phone_normalized" text GENERATED ALWAYS AS (regexp_replace(phone, '\D', '', 'g')) STORED,
	"name" text,
	"email" text,
	"company" text,
	"avatar_url" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"assigned_agent_id" uuid,
	"last_message_text" text,
	"last_message_at" timestamp (3) with time zone,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"ai_autoreply_disabled" boolean DEFAULT false NOT NULL,
	"ai_reply_count" integer DEFAULT 0 NOT NULL,
	"ai_handoff_summary" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_status_check" CHECK ("conversations"."status" in ('open', 'pending', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "custom_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"field_name" text NOT NULL,
	"field_type" text DEFAULT 'text' NOT NULL,
	"field_options" jsonb,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"contact_id" uuid,
	"conversation_id" uuid,
	"assigned_to" uuid,
	"title" text NOT NULL,
	"value" numeric(12, 2) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"notes" text,
	"expected_close_date" date,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deals_status_check" CHECK ("deals"."status" in ('open', 'won', 'lost'))
);
--> statement-breakpoint
CREATE TABLE "flow_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flow_id" uuid NOT NULL,
	"node_key" text NOT NULL,
	"node_type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position_x" integer DEFAULT 0 NOT NULL,
	"position_y" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_nodes_flow_id_node_key_key" UNIQUE("flow_id","node_key"),
	CONSTRAINT "flow_nodes_node_type_check" CHECK ("flow_nodes"."node_type" in ('start', 'send_buttons', 'send_list', 'send_message', 'send_media', 'collect_input', 'condition', 'set_tag', 'handoff', 'http_fetch', 'end'))
);
--> statement-breakpoint
CREATE TABLE "flow_run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flow_run_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"node_key" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_run_events_event_type_check" CHECK ("flow_run_events"."event_type" in ('started', 'node_entered', 'message_sent', 'reply_received', 'fallback_fired', 'handoff', 'timeout', 'error', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "flow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flow_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid,
	"conversation_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"current_node_key" text,
	"last_prompt_message_id" uuid,
	"vars" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reprompt_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_advanced_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp (3) with time zone,
	"end_reason" text,
	CONSTRAINT "flow_runs_status_check" CHECK ("flow_runs"."status" in ('active', 'completed', 'handed_off', 'timed_out', 'paused_by_agent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"trigger_type" text NOT NULL,
	"trigger_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"entry_node_id" text,
	"fallback_policy" jsonb DEFAULT '{"on_unknown_reply":"reprompt","max_reprompts":2,"on_timeout_hours":24,"on_exhaust":"handoff"}'::jsonb NOT NULL,
	"execution_count" integer DEFAULT 0 NOT NULL,
	"last_executed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flows_status_check" CHECK ("flows"."status" in ('draft', 'active', 'archived')),
	CONSTRAINT "flows_trigger_type_check" CHECK ("flows"."trigger_type" in ('keyword', 'first_inbound_message', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "member_presence" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"status" text DEFAULT 'online' NOT NULL,
	"last_seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_presence_status_check" CHECK ("member_presence"."status" in ('online', 'away'))
);
--> statement-breakpoint
CREATE TABLE "message_reactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"emoji" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_reactions_msg_actor_unique" UNIQUE("message_id","actor_type","actor_id"),
	CONSTRAINT "message_reactions_actor_type_check" CHECK ("message_reactions"."actor_type" in ('customer', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT 'Marketing' NOT NULL,
	"language" text DEFAULT 'en_US' NOT NULL,
	"header_type" text,
	"header_content" text,
	"body_text" text NOT NULL,
	"footer_text" text,
	"buttons" jsonb,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"sample_values" jsonb,
	"meta_template_id" text,
	"rejection_reason" text,
	"quality_score" text,
	"header_handle" text,
	"header_media_url" text,
	"submission_error" text,
	"last_submitted_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_templates_account_name_language_key" UNIQUE("account_id","name","language"),
	CONSTRAINT "message_templates_category_check" CHECK ("message_templates"."category" in ('Marketing', 'Utility', 'Authentication')),
	CONSTRAINT "message_templates_header_type_check" CHECK ("message_templates"."header_type" in ('text', 'image', 'video', 'document')),
	CONSTRAINT "message_templates_status_check" CHECK ("message_templates"."status" in ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION')),
	CONSTRAINT "message_templates_quality_score_check" CHECK ("message_templates"."quality_score" is null or "message_templates"."quality_score" in ('GREEN', 'YELLOW', 'RED')),
	CONSTRAINT "message_templates_buttons_check" CHECK ("message_templates"."buttons" is null or (jsonb_typeof("message_templates"."buttons") = 'array' and jsonb_array_length("message_templates"."buttons") <= 10))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_type" text NOT NULL,
	"sender_id" uuid,
	"content_type" text DEFAULT 'text' NOT NULL,
	"content_text" text,
	"media_url" text,
	"media_type" text,
	"template_name" text,
	"message_id" text,
	"status" text DEFAULT 'sent' NOT NULL,
	"reply_to_message_id" uuid,
	"interactive_reply_id" text,
	"interactive_payload" jsonb,
	"ai_generated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_sender_type_check" CHECK ("messages"."sender_type" in ('customer', 'agent', 'bot')),
	CONSTRAINT "messages_content_type_check" CHECK ("messages"."content_type" in ('text', 'image', 'document', 'audio', 'video', 'location', 'template', 'interactive')),
	CONSTRAINT "messages_status_check" CHECK ("messages"."status" in ('sending', 'sent', 'delivered', 'read', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text DEFAULT 'conversation_assigned' NOT NULL,
	"conversation_id" uuid,
	"contact_id" uuid,
	"actor_user_id" uuid,
	"title" text NOT NULL,
	"body" text,
	"read_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_type_check" CHECK ("notifications"."type" in ('conversation_assigned'))
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"used_at" timestamp (3) with time zone,
	CONSTRAINT "password_reset_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "pipeline_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"color" text DEFAULT '#3b82f6' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"account_role" "account_role_enum" NOT NULL,
	"full_name" text NOT NULL,
	"email" text NOT NULL,
	"avatar_url" text,
	"role" text DEFAULT 'user',
	"beta_features" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "quick_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"kind" text DEFAULT 'text' NOT NULL,
	"content_text" text,
	"interactive_payload" jsonb,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quick_replies_kind_check" CHECK ("quick_replies"."kind" in ('text', 'interactive'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"user_agent" text,
	"ip_address" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#3b82f6' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"created_by" uuid,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"events" text[] DEFAULT '{}' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_delivery_at" timestamp (3) with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"phone_number_id" text NOT NULL,
	"waba_id" text,
	"access_token" text NOT NULL,
	"verify_token" text,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"connected_at" timestamp (3) with time zone,
	"registered_at" timestamp (3) with time zone,
	"subscribed_apps_at" timestamp (3) with time zone,
	"last_registration_error" text,
	"mirror_inbound_media" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_config_account_id_unique" UNIQUE("account_id"),
	CONSTRAINT "whatsapp_config_phone_number_id_unique" UNIQUE("phone_number_id"),
	CONSTRAINT "whatsapp_config_status_check" CHECK ("whatsapp_config"."status" in ('connected', 'disconnected'))
);
--> statement-breakpoint
ALTER TABLE "account_invitations" ADD CONSTRAINT "account_invitations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_invitations" ADD CONSTRAINT "account_invitations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_invitations" ADD CONSTRAINT "account_invitations_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_configs" ADD CONSTRAINT "ai_configs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_configs" ADD CONSTRAINT "ai_configs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_configs" ADD CONSTRAINT "ai_configs_handoff_agent_id_users_id_fk" FOREIGN KEY ("handoff_agent_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_chunks" ADD CONSTRAINT "ai_knowledge_chunks_document_id_ai_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."ai_knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_chunks" ADD CONSTRAINT "ai_knowledge_chunks_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_documents" ADD CONSTRAINT "ai_knowledge_documents_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_documents" ADD CONSTRAINT "ai_knowledge_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_logs" ADD CONSTRAINT "automation_logs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_logs" ADD CONSTRAINT "automation_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_logs" ADD CONSTRAINT "automation_logs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_logs" ADD CONSTRAINT "automation_logs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_pending_executions" ADD CONSTRAINT "automation_pending_executions_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_pending_executions" ADD CONSTRAINT "automation_pending_executions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_pending_executions" ADD CONSTRAINT "automation_pending_executions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_pending_executions" ADD CONSTRAINT "automation_pending_executions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_pending_executions" ADD CONSTRAINT "automation_pending_executions_log_id_automation_logs_id_fk" FOREIGN KEY ("log_id") REFERENCES "public"."automation_logs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_pending_executions" ADD CONSTRAINT "automation_pending_executions_parent_step_id_automation_steps_id_fk" FOREIGN KEY ("parent_step_id") REFERENCES "public"."automation_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_steps" ADD CONSTRAINT "automation_steps_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_steps" ADD CONSTRAINT "automation_steps_parent_step_id_automation_steps_id_fk" FOREIGN KEY ("parent_step_id") REFERENCES "public"."automation_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_custom_values" ADD CONSTRAINT "contact_custom_values_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_custom_values" ADD CONSTRAINT "contact_custom_values_custom_field_id_custom_fields_id_fk" FOREIGN KEY ("custom_field_id") REFERENCES "public"."custom_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_fields" ADD CONSTRAINT "custom_fields_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_fields" ADD CONSTRAINT "custom_fields_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_assigned_to_profiles_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_nodes" ADD CONSTRAINT "flow_nodes_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_run_events" ADD CONSTRAINT "flow_run_events_flow_run_id_flow_runs_id_fk" FOREIGN KEY ("flow_run_id") REFERENCES "public"."flow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_last_prompt_message_id_messages_id_fk" FOREIGN KEY ("last_prompt_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flows" ADD CONSTRAINT "flows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flows" ADD CONSTRAINT "flows_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_presence" ADD CONSTRAINT "member_presence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_presence" ADD CONSTRAINT "member_presence_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_message_id_messages_id_fk" FOREIGN KEY ("reply_to_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quick_replies" ADD CONSTRAINT "quick_replies_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quick_replies" ADD CONSTRAINT "quick_replies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_config" ADD CONSTRAINT "whatsapp_config_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_config" ADD CONSTRAINT "whatsapp_config_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_account_invitations_account_pending" ON "account_invitations" USING btree ("account_id","expires_at") WHERE "account_invitations"."accepted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_accounts_one_per_owner" ON "accounts" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ai_knowledge_chunks_account_id_idx" ON "ai_knowledge_chunks" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ai_knowledge_chunks_document_id_idx" ON "ai_knowledge_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "ai_knowledge_chunks_fts_idx" ON "ai_knowledge_chunks" USING gin ("fts");--> statement-breakpoint
CREATE INDEX "ai_knowledge_chunks_embedding_idx" ON "ai_knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "ai_knowledge_documents_account_id_idx" ON "ai_knowledge_documents" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_ai_usage_log_account_created" ON "ai_usage_log" USING btree ("account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "api_keys_account_id_idx" ON "api_keys" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_automation_logs_account" ON "automation_logs" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_automation_logs_automation" ON "automation_logs" USING btree ("automation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_automation_pending_due" ON "automation_pending_executions" USING btree ("run_at") WHERE "automation_pending_executions"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_automation_pending_account" ON "automation_pending_executions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_automation_steps_automation_id" ON "automation_steps" USING btree ("automation_id","position");--> statement-breakpoint
CREATE INDEX "idx_automation_steps_parent" ON "automation_steps" USING btree ("parent_step_id") WHERE "automation_steps"."parent_step_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_automations_account" ON "automations" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_automations_account_active_trigger" ON "automations" USING btree ("account_id","trigger_type") WHERE "automations"."is_active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_broadcast_recipients_wamid" ON "broadcast_recipients" USING btree ("whatsapp_message_id") WHERE "broadcast_recipients"."whatsapp_message_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_broadcast_recipients_broadcast_status" ON "broadcast_recipients" USING btree ("broadcast_id","status");--> statement-breakpoint
CREATE INDEX "idx_broadcasts_account" ON "broadcasts" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_broadcasts_scheduled_due" ON "broadcasts" USING btree ("scheduled_at") WHERE "broadcasts"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "idx_contact_notes_account" ON "contact_notes" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_contact_notes_contact" ON "contact_notes" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "idx_contact_tags_tag" ON "contact_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_contacts_account_phone_normalized" ON "contacts" USING btree ("account_id","phone_normalized") WHERE "contacts"."phone_normalized" <> '';--> statement-breakpoint
CREATE INDEX "idx_contacts_account" ON "contacts" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_contacts_phone" ON "contacts" USING btree ("phone");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_conversations_account_contact" ON "conversations" USING btree ("account_id","contact_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_contact_id" ON "conversations" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_account_last_message" ON "conversations" USING btree ("account_id","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_custom_fields_account" ON "custom_fields" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_deals_account" ON "deals" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_deals_pipeline" ON "deals" USING btree ("pipeline_id");--> statement-breakpoint
CREATE INDEX "idx_deals_stage" ON "deals" USING btree ("stage_id");--> statement-breakpoint
CREATE INDEX "idx_deals_assigned_to" ON "deals" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "idx_flow_run_events_run_time" ON "flow_run_events" USING btree ("flow_run_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_flow_runs_account" ON "flow_runs" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_flow_runs_active_advanced" ON "flow_runs" USING btree ("last_advanced_at") WHERE "flow_runs"."status" = 'active';--> statement-breakpoint
CREATE INDEX "idx_flow_runs_flow_started" ON "flow_runs" USING btree ("flow_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_one_active_run_per_contact" ON "flow_runs" USING btree ("account_id","contact_id") WHERE "flow_runs"."status" = 'active';--> statement-breakpoint
CREATE INDEX "idx_flows_account" ON "flows" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_flows_account_active_trigger" ON "flows" USING btree ("account_id","trigger_type") WHERE "flows"."status" = 'active';--> statement-breakpoint
CREATE INDEX "member_presence_account_idx" ON "member_presence" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_message_reactions_conversation" ON "message_reactions" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_message_templates_meta_template_id" ON "message_templates" USING btree ("meta_template_id") WHERE "message_templates"."meta_template_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_messages_conversation_message_id" ON "messages" USING btree ("conversation_id","message_id");--> statement-breakpoint
CREATE INDEX "idx_messages_conversation_created" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_messages_message_id" ON "messages" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_messages_reply_to" ON "messages" USING btree ("reply_to_message_id") WHERE "messages"."reply_to_message_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_notifications_user_created" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_notifications_user_unread" ON "notifications" USING btree ("user_id") WHERE "notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "idx_password_reset_tokens_user" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_pipeline_stages_pipeline" ON "pipeline_stages" USING btree ("pipeline_id");--> statement-breakpoint
CREATE INDEX "idx_pipelines_account" ON "pipelines" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_profiles_account_role" ON "profiles" USING btree ("account_id","account_role");--> statement-breakpoint
CREATE INDEX "idx_quick_replies_account" ON "quick_replies" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_tags_account" ON "tags" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_account_id_idx" ON "webhook_endpoints" USING btree ("account_id");