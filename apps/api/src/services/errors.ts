export class NotImplementedError extends Error {
  constructor(feature: string) {
    super(`Not implemented in v1: ${feature}`);
    this.name = 'NotImplementedError';
  }
}

export class MalformedPlanRulesError extends Error {
  constructor(planId: string, calculationType: string, reason: string) {
    super(`Plan ${planId} (${calculationType}) has malformed rules: ${reason}`);
    this.name = 'MalformedPlanRulesError';
  }
}

export class InvalidProjectConfigError extends Error {
  constructor(projectId: string, reason: string) {
    super(`Project ${projectId} has invalid config: ${reason}`);
    this.name = 'InvalidProjectConfigError';
  }
}
