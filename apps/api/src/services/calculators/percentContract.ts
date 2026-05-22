import Decimal from 'decimal.js';
import type { CommissionRules } from '../../db/schema/plans';
import { MalformedPlanRulesError } from '../errors';

/**
 * Calculates commission for a percent_contract plan.
 * amount = contract_value * (percent / 100) * (split_percent / 100)
 * Rounded to 2dp with banker's rounding.
 */
export function calcPercentContract(
  planId: string,
  rules: CommissionRules,
  contractValue: string,
  splitPercent: string
): { amount: Decimal; explanation: string } {
  if (rules.percent === undefined || rules.percent === null) {
    throw new MalformedPlanRulesError(planId, 'percent_contract', 'missing rules.percent');
  }

  const pct = new Decimal(rules.percent);
  const cv = new Decimal(contractValue);
  const split = new Decimal(splitPercent);

  const gross = cv.mul(pct).div(100);
  const net = gross.mul(split).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);

  const explanation = `${pct.toFixed()}% of $${cv.toFixed(2)} × ${split.toFixed()}% split = $${net.toFixed(2)}`;
  return { amount: net, explanation };
}
