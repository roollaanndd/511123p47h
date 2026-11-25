-- Security audit atomicity migration (2026-11-25)
-- C2: Serialize coin redemptions per agent with FOR UPDATE lock.
-- H1: Atomic PIN failed-attempt counter + lockout.

CREATE OR REPLACE FUNCTION public.redeem_agent_coins(
  p_agent_id uuid,
  p_coins integer,
  p_description text DEFAULT 'Pencairan koin'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance bigint;
BEGIN
  IF p_coins IS NULL OR p_coins <= 0 THEN
    RAISE EXCEPTION 'coins must be a positive integer';
  END IF;

  PERFORM 1 FROM public.sp_users WHERE id = p_agent_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent not found';
  END IF;

  SELECT COALESCE(SUM(
    CASE WHEN type = 'REDEEMED' THEN -ABS(coins) ELSE coins END
  ), 0)
  INTO v_balance
  FROM public.sp_coin_ledger
  WHERE agent_id = p_agent_id;

  IF v_balance < p_coins THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Insufficient balance', 'balance', v_balance);
  END IF;

  INSERT INTO public.sp_coin_ledger (agent_id, type, coins, rp_value, description)
  VALUES (p_agent_id, 'REDEEMED', -p_coins, -(p_coins * 1000), COALESCE(NULLIF(p_description, ''), 'Pencairan koin'));

  PERFORM public.increment_coins_balance(p_agent_id, -p_coins);

  RETURN jsonb_build_object('ok', true, 'remaining_balance', v_balance - p_coins);
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_agent_coins(uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_agent_coins(uuid, integer, text) TO service_role;

CREATE OR REPLACE FUNCTION public.record_pin_failure(
  p_user_id uuid,
  p_max_attempts integer DEFAULT 5,
  p_lockout_minutes integer DEFAULT 15
)
RETURNS TABLE(attempts integer, locked boolean, locked_until timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempts integer;
  v_locked boolean;
  v_locked_until timestamptz;
BEGIN
  UPDATE public.sp_users
  SET
    pin_failed_attempts = LEAST(COALESCE(pin_failed_attempts, 0) + 1, p_max_attempts),
    pin_locked_until = CASE
      WHEN COALESCE(pin_failed_attempts, 0) + 1 >= p_max_attempts
      THEN now() + make_interval(mins => p_lockout_minutes)
      ELSE pin_locked_until
    END
  WHERE id = p_user_id
  RETURNING pin_failed_attempts, (pin_failed_attempts >= p_max_attempts), pin_locked_until
  INTO v_attempts, v_locked, v_locked_until;

  RETURN QUERY SELECT v_attempts, v_locked, v_locked_until;
END;
$$;

REVOKE ALL ON FUNCTION public.record_pin_failure(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_pin_failure(uuid, integer, integer) TO service_role;
