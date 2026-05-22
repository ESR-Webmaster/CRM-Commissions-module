"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.nullLogger = void 0;
exports.getTestDb = getTestDb;
exports.closeTestDb = closeTestDb;
exports.resetDb = resetDb;
exports.createOrg = createOrg;
exports.createPlan = createPlan;
exports.createPlanAssignment = createPlanAssignment;
exports.createProject = createProject;
exports.createOverrideRule = createOverrideRule;
const postgres_1 = __importDefault(require("postgres"));
const postgres_js_1 = require("drizzle-orm/postgres-js");
const drizzle_orm_1 = require("drizzle-orm");
const schema = __importStar(require("../../src/db/schema/index"));
// ── Connection ────────────────────────────────────────────────────────────────
const TEST_DB_URL = process.env['DATABASE_URL'] ??
    'postgresql://commissions:commissions@localhost:5433/commissions';
let _client = null;
let _db = null;
function getTestDb() {
    if (!_db) {
        _client = (0, postgres_1.default)(TEST_DB_URL, { max: 5 });
        _db = (0, postgres_js_1.drizzle)(_client, { schema });
    }
    return _db;
}
async function closeTestDb() {
    if (_client) {
        await _client.end();
        _client = null;
        _db = null;
    }
}
// ── Reset ─────────────────────────────────────────────────────────────────────
async function resetDb(db) {
    await db.execute((0, drizzle_orm_1.sql) `TRUNCATE orgs, commission_plans, plan_assignments,
      project_commission_configs, commission_events, commission_adjustments,
      override_rules, payout_statements, audit_log RESTART IDENTITY CASCADE`);
}
// ── Factories ────────────────────────────────────────────────────────────────
async function createOrg(db, overrides) {
    const [row] = await db
        .insert(schema.orgs)
        .values({
        id: overrides?.id ?? crypto.randomUUID(),
        name: overrides?.name ?? 'Test Org',
        settings: overrides?.settings ?? { require_event_approval: false },
    })
        .returning();
    return row;
}
async function createPlan(db, orgId, overrides) {
    const [row] = await db
        .insert(schema.commissionPlans)
        .values({
        id: overrides?.id ?? crypto.randomUUID(),
        orgId,
        name: overrides?.name ?? 'Test Plan',
        calculationType: overrides?.calculationType ?? 'percent_contract',
        rules: overrides?.rules ?? { percent: 3 },
        earnedTriggerStage: overrides?.earnedTriggerStage ?? 'install_complete',
        payableTrigger: overrides?.payableTrigger ?? { type: 'stage', value: 'install_complete' },
        clawbackConfig: overrides?.clawbackConfig !== undefined ? overrides.clawbackConfig : null,
        effectiveFrom: overrides?.effectiveFrom ?? new Date('2020-01-01'),
        effectiveTo: overrides?.effectiveTo ?? null,
        isActive: overrides?.isActive ?? true,
    })
        .returning();
    return row;
}
async function createPlanAssignment(db, { orgId, planId, userId, role, effectiveFrom, effectiveTo, splitPercent, }) {
    const [row] = await db
        .insert(schema.planAssignments)
        .values({
        orgId,
        planId,
        userId,
        role,
        defaultSplitPercent: splitPercent ?? '100.00',
        effectiveFrom: effectiveFrom ?? new Date('2020-01-01'),
        effectiveTo: effectiveTo ?? null,
    })
        .returning();
    return row;
}
async function createProject(db, { orgId, projectId, repAssignments, planOverrideId, contractValue, systemSizeKw, }) {
    const [row] = await db
        .insert(schema.projectCommissionConfigs)
        .values({
        projectId: projectId ?? crypto.randomUUID(),
        orgId,
        repAssignments,
        planOverrideId: planOverrideId ?? null,
        contractValue: contractValue ?? '25000.00',
        systemSizeKw: systemSizeKw ?? '10.00',
    })
        .returning();
    return row;
}
async function createOverrideRule(db, { orgId, managerUserId, teamMemberUserIds, overridePercent, appliesToPlanIds, effectiveFrom, effectiveTo, }) {
    const [row] = await db
        .insert(schema.overrideRules)
        .values({
        orgId,
        managerUserId,
        teamMemberUserIds,
        overridePercent,
        appliesToPlanIds: appliesToPlanIds ?? null,
        effectiveFrom: effectiveFrom ?? new Date('2020-01-01'),
        effectiveTo: effectiveTo ?? null,
    })
        .returning();
    return row;
}
// ── Null logger (suppresses engine output during tests unless DEBUG=1) ────────
exports.nullLogger = {
    debug: process.env['DEBUG'] ? console.debug.bind(console) : () => undefined,
    info: process.env['DEBUG'] ? console.info.bind(console) : () => undefined,
    warn: console.warn.bind(console),
    error: console.error.bind(console),
};
//# sourceMappingURL=engine-fixtures.js.map