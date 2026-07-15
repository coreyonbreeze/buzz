-- Bound the recurring wake-outbox retention scan by creation order. The
-- reaper filters terminal and no-longer-deliverable rows from this ordered
-- prefix and deletes only a fixed-size batch on each tick.
CREATE INDEX push_wake_outbox_retention
    ON push_wake_outbox (created_at, community_id, id);

-- A member can create multiple leases that match one event, so retention alone
-- is not an admission boundary. Keep a race-safe row budget per community and
-- drop only the wake when that budget is exhausted; the source event remains
-- accepted and available through the relay.
CREATE TABLE push_wake_outbox_community_state (
    community_id UUID PRIMARY KEY REFERENCES communities(id),
    retained_rows BIGINT NOT NULL DEFAULT 0 CHECK (retained_rows >= 0),
    max_retained_rows BIGINT NOT NULL DEFAULT 100000 CHECK (max_retained_rows > 0),
    dropped_wakes BIGINT NOT NULL DEFAULT 0 CHECK (dropped_wakes >= 0)
);

INSERT INTO push_wake_outbox_community_state (community_id, retained_rows)
SELECT community_id, count(*)
FROM push_wake_outbox
GROUP BY community_id;

CREATE FUNCTION admit_push_wake_outbox_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO push_wake_outbox_community_state (community_id)
    VALUES (NEW.community_id)
    ON CONFLICT (community_id) DO NOTHING;

    UPDATE push_wake_outbox_community_state
    SET retained_rows = retained_rows + 1
    WHERE community_id = NEW.community_id
      AND retained_rows < max_retained_rows;

    IF NOT FOUND THEN
        UPDATE push_wake_outbox_community_state
        SET dropped_wakes = dropped_wakes + 1
        WHERE community_id = NEW.community_id;
        RETURN NULL;
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER push_wake_outbox_admission
BEFORE INSERT ON push_wake_outbox
FOR EACH ROW EXECUTE FUNCTION admit_push_wake_outbox_row();

CREATE FUNCTION account_push_wake_outbox_deletes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE push_wake_outbox_community_state state
    SET retained_rows = GREATEST(0, state.retained_rows - deleted.count)
    FROM (
        SELECT community_id, count(*) AS count
        FROM deleted_push_wakes
        GROUP BY community_id
    ) deleted
    WHERE state.community_id = deleted.community_id;
    RETURN NULL;
END
$$;

CREATE TRIGGER push_wake_outbox_delete_accounting
AFTER DELETE ON push_wake_outbox
REFERENCING OLD TABLE AS deleted_push_wakes
FOR EACH STATEMENT EXECUTE FUNCTION account_push_wake_outbox_deletes();
