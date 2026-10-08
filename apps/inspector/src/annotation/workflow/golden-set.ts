import type { SourceIdentityV1, TimeRangeV1 } from "../contracts";
import type { PlaybackRate } from "../playback-rate";
import type { AssessmentV2, ReviewBaseV2 } from "./contracts";

export interface GoldenHuman {
  readonly id: string;
  readonly observationSha256: string;
  readonly foundationSha256: string;
  readonly documentVersion: ReviewBaseV2;
  readonly comment?: string;
}

export interface GoldenSection {
  readonly caseId: string;
  readonly sourceSha256: string;
  readonly source: SourceIdentityV1;
  readonly scope: TimeRangeV1;
  readonly reviewContext: TimeRangeV1;
  readonly playbackRate: PlaybackRate;
  readonly gold: Readonly<Record<string, AssessmentV2>>;
  readonly humans: Readonly<Record<string, readonly GoldenHuman[]>>;
}

export interface GoldenSet {
  readonly checkedAt: string;
  readonly cases: readonly GoldenSection[];
  readonly gateError?: string;
}

export function goldenAssessment(assessment: AssessmentV2): string {
  return assessment.presence === "present" ? assessment.salience : assessment.presence;
}
