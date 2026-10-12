ALTER TABLE preview_messages ADD COLUMN sequence bigint GENERATED ALWAYS AS IDENTITY;
CREATE INDEX preview_conversation_order ON preview_messages(workspace_id,conversation_id,sequence);
