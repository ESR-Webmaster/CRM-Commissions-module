import * as schema from '../../src/db/schema/index';
import type { Db } from '../../src/db/index';
import type { ClawbackConfig, CommissionRules, PayableTrigger } from '../../src/db/schema/plans';
import type { RepAssignment } from '../../src/db/schema/projects';
import type { OrgSettings } from '../../src/db/schema/orgs';
export declare function getTestDb(): Db;
export declare function closeTestDb(): Promise<void>;
export declare function resetDb(db: Db): Promise<void>;
export declare function createOrg(db: Db, overrides?: Partial<{
    id: string;
    name: string;
    settings: OrgSettings;
}>): Promise<{
    id: string;
    name: string;
    settings: schema.OrgSettings;
    createdAt: Date;
}>;
export declare function createPlan(db: Db, orgId: string, overrides?: Partial<{
    id: string;
    name: string;
    calculationType: 'percent_contract' | 'ppw' | 'tiered' | 'hybrid';
    rules: CommissionRules;
    earnedTriggerStage: string;
    payableTrigger: PayableTrigger;
    clawbackConfig: ClawbackConfig | null;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    isActive: boolean;
}>): Promise<{
    id: string;
    name: string;
    createdAt: Date;
    orgId: string;
    calculationType: "percent_contract" | "ppw" | "tiered" | "hybrid";
    rules: schema.CommissionRules;
    earnedTriggerStage: string;
    payableTrigger: schema.PayableTrigger;
    clawbackConfig: schema.ClawbackConfig | null;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    isActive: boolean;
    updatedAt: Date;
}>;
export declare function createPlanAssignment(db: Db, { orgId, planId, userId, role, effectiveFrom, effectiveTo, splitPercent, }: {
    orgId: string;
    planId: string;
    userId: string;
    role: 'closer' | 'setter' | 'manager' | 'override_recipient';
    effectiveFrom?: Date;
    effectiveTo?: Date | null;
    splitPercent?: string;
}): Promise<{
    id: string;
    orgId: string;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    planId: string;
    userId: string;
    role: "closer" | "setter" | "manager" | "override_recipient";
    defaultSplitPercent: string;
}>;
export declare function createProject(db: Db, { orgId, projectId, repAssignments, planOverrideId, contractValue, systemSizeKw, }: {
    orgId: string;
    projectId?: string;
    repAssignments: RepAssignment[];
    planOverrideId?: string | null;
    contractValue?: string;
    systemSizeKw?: string;
}): Promise<{
    id: string;
    createdAt: Date;
    orgId: string;
    updatedAt: Date;
    projectId: string;
    repAssignments: schema.RepAssignment[];
    planOverrideId: string | null;
    contractValue: string;
    systemSizeKw: string;
}>;
export declare function createOverrideRule(db: Db, { orgId, managerUserId, teamMemberUserIds, overridePercent, appliesToPlanIds, effectiveFrom, effectiveTo, }: {
    orgId: string;
    managerUserId: string;
    teamMemberUserIds: string[];
    overridePercent: string;
    appliesToPlanIds?: string[] | null;
    effectiveFrom?: Date;
    effectiveTo?: Date | null;
}): Promise<{
    id: string;
    orgId: string;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    managerUserId: string;
    teamMemberUserIds: string[];
    overridePercent: string;
    appliesToPlanIds: string[] | null;
}>;
export declare const nullLogger: {
    debug: (message?: any, ...optionalParams: any[]) => void;
    info: (message?: any, ...optionalParams: any[]) => void;
    warn: (message?: any, ...optionalParams: any[]) => void;
    error: (message?: any, ...optionalParams: any[]) => void;
};
//# sourceMappingURL=engine-fixtures.d.ts.map