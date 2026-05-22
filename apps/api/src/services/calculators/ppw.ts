import Decimal from 'decimal.js';
import type { CommissionRules } from '../../db/schema/plans';
import { MalformedPlanRulesError } from '../errors';

/**
 * Calculates commission for a ppw (price per watt) plan.
 * amount = (system_size_kw * 1000) * dollars_per_watt * (split_percent / 100)
 * Rounded to 2dp with banker's rounding.
 */
export function calcPpw(
  planId: string,
  rules: CommissionRules,
  systemSizeKw: string,
  splitPercent: string
): { amount: Decimal; explanation: string } {
  if (rules.dollars_per_watt === undefined || rules.dollars_per_watt === null) {
    throw new MalformedPlanRulesError(planId, 'ppw', 'missing rules.dollars_per_watt');
  }

  const dpw = new Decimal(rules.dollars_per_watt);
  const watts = new Decimal(systemSizeKw).mul(1000);
  const split = new Decimal(splitPercent);

  const gross = watts.mul(dpw);
  const net = gross.mul(split).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);

  const explanation = `${watts.toFixed()} W × $${dpw.toFixed(3)}/W × ${split.toFixed()}% split = $${net.toFixed(2)}`;
  return { amount: net, explanation };
}
