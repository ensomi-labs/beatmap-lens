<script setup lang="ts">
import { parseBeatmap, renderDefaults, renderSvgPages } from "beatmap-lens";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useSlots, watch } from "vue";
import AnnotationTimeline from "./AnnotationTimeline.vue";
import AudioVolumeControl from "./AudioVolumeControl.vue";
import { AUDIO_OFFSET_PREFERENCE_KEY, AudioPlaybackController, type AudioPlaybackStatus, MUSIC_PREFERENCE_KEY } from "./annotation/audio-playback";
import { AUDIO_VOLUME_PREFERENCE_KEY, DEFAULT_AUDIO_VOLUME } from "./annotation/audio-volume";
import { BufferedSceneController, judgmentLineRatio, projectSceneRange } from "./annotation/buffered-scene";
import { serializeCanonicalJson } from "./annotation/canonical-json";
import type { StableNoteRefV1, TimeRangeV1 } from "./annotation/contracts";
import { pickDatasetDirectory } from "./annotation/file-system-access";
import { ManiaNoteTimeIndex } from "./annotation/note-time-index";
import { type PlaybackRate, resolvePlaybackRate, SUPPORTED_PLAYBACK_RATES } from "./annotation/playback-rate";
import { chartEndMs } from "./annotation/range";
import { IndexedDbSessionStore, type SessionPreferences } from "./annotation/session-store";
import { type InspectedOsuSourceV1, inspectOsuSourceV1 } from "./annotation/source-identity";
import { createStableNoteRefV1, stableNoteRefKey } from "./annotation/stable-note-ref";
import { formatTimelineRangeTime as formatTime } from "./annotation/timeline-range";
import { fitTimelineViewRange, timelineZoomAnchorMs, zoomTimelineViewRangeAtTime } from "./annotation/timeline-view-range";
import type { AgentReviewV2, ClaimV2, CommunityAlignmentV2, EvidenceReviewV2, FoundationTagV2, FoundationV2, HumanConfidenceV2, HumanObservationV2, ReviewBaseV2, TaskPacketV2 } from "./annotation/workflow/contracts";
import { type StoredReviewV2, WorkflowDirectoryV2 } from "./annotation/workflow/directory";
import { assertTaskPacketV2, effectiveHumanObservationsV2, handoffBaseStatusV2, readAgentReviewsV2, readDispositionsV2, sameBase } from "./annotation/workflow/domain";
import { inheritedHumanEvidenceReview, newEvidenceReview, recordEvidenceOperation, updateEvidenceDraft } from "./annotation/workflow/evidence-review";
import { createExperimentalFoundationV2 } from "./annotation/workflow/experimental-campaign";
import { createRemoteReviewStore, type RemoteSourceV2, type ReviewStoreV2 } from "./annotation/workflow/remote-workspace";
import { reviewDraftStorage } from "./annotation/workflow/review-draft-storage";
import { agentVersionLabel, reviewVersionOptions, skillKey } from "./annotation/workflow/review-provenance";
import FallingNoteViewport from "./FallingNoteViewport.vue";
import LongNoteTailControl from "./LongNoteTailControl.vue";
import type { PaneSpec } from "./layout/pane-layout";
import RenderScope from "./layout/RenderScope.vue";
import type { MobilePanel } from "./layout/WorkspaceFrame.vue";
import WorkspaceFrame from "./layout/WorkspaceFrame.vue";
import WorkflowClaimEditor from "./WorkflowClaimEditor.vue";
import WorkflowSectionSliders from "./WorkflowSectionSliders.vue";
import WorkspaceModeSwitch from "./WorkspaceModeSwitch.vue";
import type { WorkspaceMode } from "./workspace-mode";

const props = withDefaults(defineProps<{ active?: boolean; remoteSource?: RemoteSourceV2; openClaim?: { handoffId: string; claimId: string }; openHumanObservationIds?: readonly string[] }>(), { active: true });
const emit = defineEmits<{ "change-mode": [mode: WorkspaceMode]; "back-to-inbox": []; saved: [] }>();
const slots = useSlots();
/**
 * The connected inbox's navigation, put in the toolbar without a `<slot>` outlet or a conditional
 * slot: either would make the frame's slots dynamic, and then every render of this component would
 * re-render every region of the frame instead of only the ones that changed.
 */
const InboxNavigation = () => slots.navigation?.();
const source = shallowRef<InspectedOsuSourceV1>();
const sourceBytes = shallowRef<Uint8Array>();
const files = shallowRef<readonly File[]>([]);
const selectedFile = ref(0);
const directory = shallowRef<ReviewStoreV2>();
const directoryName = ref("");
const stored = shallowRef<StoredReviewV2>();
const pendingTask = shallowRef<TaskPacketV2>();
const proposalEditing = ref(false);
const sectionComplete = ref(false);
const confidenceReviewActive = ref(false);
const activeConfidenceObservationIds = shallowRef<readonly string[]>([]);
const foundation = shallowRef<FoundationV2>(createExperimentalFoundationV2(new Date().toISOString()));
const humanId = ref(localStorage.getItem("beatmap-lens-review-human") ?? "");
const draftStorageWarning = ref(Object.keys(reviewDraftStorage.unsaved()).length > 0);
const status = ref("Open a difficulty or a frozen task to begin.");
const error = ref("");
const busy = ref(false);
const savingDecision = shallowRef<{ sourceSha: string; handoffId: string; claimId: string }>();
const sourceLoading = ref(false);
/** The toolbar's status line; the toolbar may truncate it, so it is also its title. */
const statusLine = computed(() =>
  savingDecision.value ? "Saving section…" : busy.value || sourceLoading.value ? "Working…" : status.value,
);
let pendingOpenClaim = false;
const mobilePanel = ref<MobilePanel>("preview");
const sourcePane: PaneSpec = { id: "review-files", label: "Files and queue", defaultSize: 260, min: 200, max: 460 };
const judgmentPane: PaneSpec = { id: "review-judgment", label: "Section judgments", defaultSize: 380, min: 300, max: 600 };
const playhead = ref(0);
const speed = ref(240);
const playbackRate = ref<PlaybackRate>(1);
const size = ref({ width: 640, height: 900 });
const timelineRange = ref<TimeRangeV1>({ startMs: 0, endMs: 1000 });
const drafts = ref<readonly ClaimV2[]>([]);
const activeClaimId = ref("");
const evidenceReviews = ref<Record<string, EvidenceReviewV2>>({});
const savedEvidenceReviews = shallowRef<Record<string, EvidenceReviewV2>>({});
const confidences = ref<Record<string, HumanConfidenceV2 | undefined>>({});
const savedConfidences = shallowRef<Record<string, HumanConfidenceV2 | undefined>>({});
const activeEvidenceReview = computed(() => evidenceReviews.value[activeClaimId.value] ?? newEvidenceReview("unknown"));
const evidenceOriginLabel: Record<EvidenceReviewV2["selectionOrigin"], string> = {
  "inherited-agent": "Agent proposal", "inherited-human": "Previous human observation", "new-human": "New human section",
  "copied-section": "Copied section evidence", unknown: "No recorded selection source",
};
function evidenceOperationLabel(operation: EvidenceReviewV2["operations"][number]): string {
  if (operation.kind === "auto-scope-fill") return "Automatically filled section notes";
  if (operation.kind === "explicit-scope-selection") return "Explicitly selected whole arrangement";
  if (operation.kind === "range-filter") return "Adjusted evidence to section or context range";
  return operation.target === "context" ? "Edited context notes" : "Edited witnesses";
}
const editorOrigin = ref<"direct" | "proposal" | "observation" | "calibration">("direct");
const activeHandoffId = ref("");
const activeObservationId = ref("");
const sectionObservationIds = ref<Record<string, string>>({});
const savedSectionDrafts = shallowRef<readonly ClaimV2[]>([]);
const sectionProposals = shallowRef<readonly ClaimV2[]>([]);
const historicalObservation = shallowRef<HumanObservationV2>();
const decisionNote = ref("");
const evidenceMode = ref<"noteRefs" | "contextNoteRefs">("noteRefs");
const selectionAnchor = ref<number>();
const gestureClaim = shallowRef<ClaimV2>();
const gestureDrafts = shallowRef<readonly ClaimV2[]>();
const gestureEvidenceReviews = shallowRef<Record<string, EvidenceReviewV2>>();
const gestureConfidences = shallowRef<Record<string, HumanConfidenceV2 | undefined>>();
const gestureEdge = ref("select");
const notePage = ref(0);
const restoring = ref(false);
const editorBase = shallowRef<ReviewBaseV2>();
const editorReviewRevision = ref<number>();
const handoffStatuses = ref<Record<string, string>>({});
const agentReviews = shallowRef<readonly AgentReviewV2[]>([]);
const expertLimit = ref(5);
const chartHistoryVersion = ref("");
const calibrationId = ref("");
const document = computed(() => stored.value?.document);
const activeFoundation = computed(() => document.value?.foundation ?? foundation.value);
const activeClaim = computed(() => drafts.value.find(claim => claim.id === activeClaimId.value));
const sectionReady = computed(() => drafts.value.length > 0 && drafts.value.every(settled));
const claimRateMatchesPlayback = computed(() => !activeClaim.value || resolvePlaybackRate(activeClaim.value.playbackRate) === playbackRate.value);
const expertQueue = computed(() => agentReviews.value.filter(review => review.status === "needs-expert"));
const activeReview = computed(() => agentReviews.value.find(review => review.handoffId === activeHandoffId.value && review.claimId === activeClaimId.value));
const activeTrust = computed(() => props.remoteSource?.handoffTrust?.[activeHandoffId.value] ?? activeReview.value?.trust);
const activeHandoff = computed(() => document.value?.handoffs.find(entry => entry.handoff.handoffId === activeHandoffId.value)?.handoff);
const auditPackets = computed(() => new Map(document.value?.audits?.map(entry => [entry.audit.auditId, entry.audit])));
const chartHistory = computed(() => agentReviews.value.map(review => {
  const handoff = document.value?.handoffs.find(entry => entry.handoff.handoffId === review.handoffId)?.handoff;
  return { handoffId: review.handoffId, claimId: review.claimId, claim: review.claim, status: review.status, rationale: review.rationale,
    tagId: review.claim.tagId, scope: review.claim.scope, ...(handoff ? { agent: handoff.agent, submittedAt: handoff.createdAt } : {}) };
}));
const chartVersions = computed(() => reviewVersionOptions(chartHistory.value, "labeler"));
const visibleHandoffs = computed(() => document.value?.handoffs.filter(entry => !chartHistoryVersion.value || skillKey(entry.handoff.agent) === chartHistoryVersion.value) ?? []);
const relatedReviews = computed(() => chartHistory.value.filter(review => activeClaim.value
  && review.claim.tagId === activeClaim.value.tagId
  && !(review.handoffId === activeHandoffId.value && review.claimId === activeClaimId.value)
  && Math.max(review.scope.startMs, activeClaim.value.scope.startMs) < Math.min(review.scope.endMs, activeClaim.value.scope.endMs))
  .sort((a, b) => (b.submittedAt ?? "").localeCompare(a.submittedAt ?? "")));
const originalProposal = computed(() => document.value?.handoffs.find(entry => entry.handoff.handoffId === activeHandoffId.value)?.handoff.proposals.find(claim => claim.id === activeClaimId.value));
const finalDecision = computed(() => decisionsForClaim.value.at(-1));
const currentObservations = computed(() => document.value ? effectiveHumanObservationsV2(document.value) : []);
const activeObservation = computed(() => document.value?.observations.find(observation => observation.id === activeObservationId.value));
const observationHistory = computed(() => {
  const entries: HumanObservationV2[] = [];
  let entry = activeObservation.value;
  while (entry) {
    entries.push(entry);
    const priorId: string | undefined = entry.supersedesObservationId;
    entry = document.value?.observations.find(observation => observation.id === priorId);
  }
  return entries;
});
const finalObservation = computed(() => document.value?.observations.find(observation => observation.id === finalDecision.value?.observationId));
const uncertainAcceptance = computed(() => Boolean(finalObservation.value && !settled(finalObservation.value.claim)));
const laterClarification = computed(() => {
  const prior = finalObservation.value;
  if (!prior || !uncertainAcceptance.value) return undefined;
  return document.value?.observations.filter(observation => observation.origin.kind === "direct-human" && observation.confirmedAt > prior.confirmedAt && observation.claim.id === prior.claim.id && observation.claim.tagId === prior.claim.tagId && resolvePlaybackRate(observation.claim.playbackRate) === resolvePlaybackRate(prior.claim.playbackRate) && observation.claim.scope.startMs === prior.claim.scope.startMs && observation.claim.scope.endMs === prior.claim.scope.endMs && settled(observation.claim)).at(-1);
});
const routineCount = computed(() => agentReviews.value.filter(review => review.status === "agent-reviewed").length);
const agentActionCount = computed(() => agentReviews.value.filter(review => ["awaiting-audit", "needs-revision", "stale"].includes(review.status)).length);
const endMs = computed(() => source.value ? chartEndMs(source.value.chart) : 1000);
const sourceVisualSpeed = computed(() => speed.value / playbackRate.value);
const controller = computed(() => source.value ? new BufferedSceneController(source.value.chart, {
  viewportHeight: size.value.height, width: size.value.width, pixelsPerSecond: sourceVisualSpeed.value, theme: { tailShortenMs: tailShortenMs.value },
}) : undefined);
const frame = computed(() => controller.value?.frame(playhead.value));
const selectedNotes = computed(() => new Set((activeClaim.value?.evidence.noteRefs ?? []).concat(activeClaim.value?.evidence.contextNoteRefs ?? []).map(stableNoteRefKey)));
const noteIndex = computed(() => new ManiaNoteTimeIndex(source.value?.chart.notes ?? []));
const noteIdsByReference = computed(() => new Map(source.value?.chart.notes.map(note => [stableNoteRefKey(createStableNoteRefV1(note)), note.id]) ?? []));
const selectedNoteIds = computed(() => new Set([...selectedNotes.value].flatMap(key => {
  const id = noteIdsByReference.value.get(key);
  return id === undefined ? [] : [id];
})));
const candidateNotes = computed(() => {
  const range = activeClaim.value?.reviewContext ?? frame.value?.viewportRange;
  return range ? noteIndex.value.notesInRange(range) : [];
});
const candidateIds = computed(() => new Set(candidateNotes.value.map(note => note.id)));
const visibleNotes = computed(() => candidateNotes.value.slice(notePage.value * 80, (notePage.value + 1) * 80));
const selectionBand = computed(() => {
  if (!activeClaim.value || !frame.value) return undefined;
  const band = projectSceneRange(frame.value.scene.projection, activeClaim.value.scope);
  return band ? { ...band, x: 0, width: size.value.width } : undefined;
});
const canEdit = computed(() => !busy.value && !sourceLoading.value && editorOrigin.value !== "calibration" && !historicalObservation.value && claimRateMatchesPlayback.value);
const approved = computed(() => activeFoundation.value.approval.status === "human-approved");
const decisionsForClaim = computed(() => document.value?.decisions.filter(decision => decision.handoffId === activeHandoffId.value && decision.claimId === activeClaimId.value) ?? []);
const draftIsStale = computed(() => editorReviewRevision.value === undefined
  ? Boolean(editorBase.value && stored.value && !sameBase(editorBase.value, stored.value.version))
  : editorReviewRevision.value !== document.value?.reviewRevision);
const calibrationExample = computed(() => activeFoundation.value.calibrationExamples.find(example => example.id === calibrationId.value));
const calibrationPages = computed(() => {
  const example = calibrationExample.value;
  if (!example) return [];
  const chart = parseBeatmap(new TextDecoder().decode(Uint8Array.from(example.sourceBytes))).chart;
  return renderSvgPages(chart, { range: example.claim.reviewContext, page: { size: { widthPx: 1200, heightPx: 900 }, columns: "auto" }, panel: { playfield: { laneWidthPx: 48 }, maxNoteRows: 32 }, scale: { type: "row-aware" }, theme: { tailShortenMs: tailShortenMs.value } });
});

const sessions = new IndexedDbSessionStore();
const playing = ref(false);
const looping = ref(false);
const playbackReady = ref(false);
const musicEnabled = ref(false);
const audioOffsetMs = ref(0);
const audioVolume = ref(DEFAULT_AUDIO_VOLUME);
const tailShortenMs = ref<number>(renderDefaults.scene.tailShortenMs);
const audioStatus = shallowRef<AudioPlaybackStatus>({ kind: "idle" });
let playback: AudioPlaybackController | undefined;
let preferenceWrite = Promise.resolve();
const preferencesReady = sessions.getPreferences().then(preferences => {
  if (!preferences) return;
  speed.value = preferences.visualSpeed;
  musicEnabled.value = preferences.musicEnabled;
  audioOffsetMs.value = preferences.audioOffsetMs ?? 0;
  audioVolume.value = preferences.audioVolume ?? DEFAULT_AUDIO_VOLUME;
  tailShortenMs.value = preferences.tailShortenMs ?? renderDefaults.scene.tailShortenMs;
}).catch(cause => { error.value = `Could not load Inspector preferences: ${String(cause)}`; });
const transportDisabled = computed(() => !playbackReady.value || busy.value || sourceLoading.value || props.active === false || Boolean(calibrationExample.value));
const audioDescription = computed(() => {
  const current = audioStatus.value;
  if ("message" in current) return current.message;
  if (current.kind === "loading") return "Loading music…";
  if (current.kind === "ready") return musicEnabled.value ? "Music on · media clock" : "Audio ready · Music off";
  return "No audio available · silent playback";
});

watch(source, async (current, _previous, onCleanup) => {
  let disposed = false;
  let clock: AudioPlaybackController | undefined;
  playbackReady.value = false;
  onCleanup(() => {
    disposed = true;
    clock?.dispose();
    playback = undefined;
    playing.value = false;
    looping.value = false;
  });
  if (!current) return;
  await preferencesReady;
  if (disposed) return;
  clock = new AudioPlaybackController({ preferenceStore: {
    getItem: key => key === MUSIC_PREFERENCE_KEY ? (musicEnabled.value ? "on" : "off") : key === AUDIO_OFFSET_PREFERENCE_KEY ? String(audioOffsetMs.value) : key === AUDIO_VOLUME_PREFERENCE_KEY ? String(audioVolume.value) : null,
    setItem: () => {},
  } });
  playback = clock;
  clock.setPlaybackRate(playbackRate.value);
  clock.seek(playhead.value);
  clock.subscribe(state => {
    if (disposed || source.value !== current) return;
    playhead.value = Math.min(state.currentTimeMs, endMs.value);
    playing.value = state.playing;
    looping.value = state.looping;
    if (state.currentTimeMs >= endMs.value && state.playing) {
      clock?.pause();
      clock?.seek(endMs.value);
    }
  });
  clock.subscribeAudio(state => {
    if (disposed || source.value !== current) return;
    musicEnabled.value = state.musicEnabled;
    audioOffsetMs.value = state.audioOffsetMs;
    audioVolume.value = state.audioVolume;
    audioStatus.value = state.status;
  });
  playbackReady.value = true;
  const remote = props.remoteSource;
  if (remote?.document.source.sha256 === current.source.sha256 && remote.audio) await clock.loadAudioUrl(remote.audio.url);
}, { flush: "post" });
watch(() => [props.active, sourceLoading.value, calibrationId.value], () => {
  if (props.active === false || sourceLoading.value || calibrationId.value) playback?.pause();
});
watch(() => [activeClaim.value?.id, activeClaim.value?.playbackRate], () => {
  if (activeClaim.value) setPlaybackRate(resolvePlaybackRate(activeClaim.value.playbackRate));
});
watch(() => [activeClaim.value?.scope.startMs, activeClaim.value?.scope.endMs], () => playback?.pause());

function savePreferences(patch: Partial<SessionPreferences>): void {
  preferenceWrite = preferenceWrite.then(async () => {
    const previous = await sessions.getPreferences();
    await sessions.setPreferences({ annotatorId: "", visualSpeed: speed.value, musicEnabled: musicEnabled.value, audioOffsetMs: audioOffsetMs.value, audioVolume: audioVolume.value, tailShortenMs: tailShortenMs.value, ...previous, ...patch });
  }).catch(cause => { error.value = `Could not save Inspector preferences: ${String(cause)}`; });
}

function seekPlayhead(timeMs: number): void {
  if (!Number.isFinite(timeMs)) return;
  const time = Math.max(0, Math.min(endMs.value, timeMs));
  playhead.value = time;
  playback?.seek(time);
}

async function togglePlayback(): Promise<void> {
  if (transportDisabled.value || !playback) return;
  if (playing.value) playback.pause();
  else {
    if (playhead.value >= endMs.value) playback.seek(0);
    await playback.play();
  }
}

async function playSelection(loop = false): Promise<void> {
  if (transportDisabled.value || !playback || !activeClaim.value) return;
  if (loop && looping.value) playback.pause();
  else if (loop) await playback.loopSelection(activeClaim.value.scope);
  else await playback.playSelection(activeClaim.value.scope);
}

async function toggleMusic(): Promise<void> {
  if (!playback) return;
  const enabled = !musicEnabled.value;
  const changing = playback.setMusicEnabled(enabled);
  savePreferences({ musicEnabled: enabled });
  await changing;
}

function setAudioOffset(value: number): void {
  if (!Number.isFinite(value)) return;
  playback?.setAudioOffsetMs(value);
  savePreferences({ audioOffsetMs: value });
}

function setAudioVolume(value: number): void {
  playback?.setAudioVolume(value);
  savePreferences({ audioVolume: value });
}

function setTailShortenMs(value: number): void {
  tailShortenMs.value = value;
  savePreferences({ tailShortenMs: value });
}

function setPlaybackRate(rate: number): void {
  playback?.pause();
  playbackRate.value = resolvePlaybackRate(rate);
  playback?.setPlaybackRate(playbackRate.value);
}

function createRateJudgment(): void {
  const original = activeClaim.value;
  if (!original || claimRateMatchesPlayback.value || busy.value || sourceLoading.value || savingDecision.value) return;
  stashDraft();
  confidenceReviewActive.value = false;
  const sectionId = crypto.randomUUID();
  const copiedClaims = drafts.value;
  drafts.value = completeSection(drafts.value, original).map(claim => ({
    ...claim, id: crypto.randomUUID(), sectionId, playbackRate: playbackRate.value,
    assessment: { presence: "unreviewed" },
    evidence: { ...claim.evidence, rationale: "" },
  }));
  evidenceReviews.value = Object.fromEntries(drafts.value.map(claim => [claim.id, newEvidenceReview("copied-section", { sourceClaimId: copiedClaims.find(source => source.tagId === claim.tagId)?.id ?? original.id })]));
  savedEvidenceReviews.value = {};
  confidences.value = Object.fromEntries(drafts.value.map(claim => [claim.id, "low"]));
  savedConfidences.value = {};
  activeClaimId.value = drafts.value.find(claim => claim.tagId === original.tagId)?.id ?? "";
  editorOrigin.value = "direct";
  activeObservationId.value = "";
  sectionObservationIds.value = {};
  savedSectionDrafts.value = [];
  activeHandoffId.value = "";
  historicalObservation.value = undefined;
  calibrationId.value = "";
  decisionNote.value = "";
  editorBase.value = stored.value?.version;
  editorReviewRevision.value = document.value?.reviewRevision;
  status.value = `New ${playbackRate.value}× section. Assess this rate before saving.`;
}

function setVisualSpeed(event: Event): void {
  const value = (event.target as HTMLInputElement).valueAsNumber;
  if (!Number.isFinite(value)) return;
  speed.value = Math.max(30, Math.min(2000, value));
  savePreferences({ visualSpeed: speed.value });
}

function panMainViewport(range: TimeRangeV1): void {
  seekPlayhead(range.startMs <= 0 ? 0 : range.endMs >= endMs.value ? endMs.value : range.startMs + (range.endMs - range.startMs) * (1 - judgmentLineRatio));
}

function zoomTimeline(direction: -1 | 1): void {
  timelineRange.value = zoomTimelineViewRangeAtTime({ anchorMs: timelineZoomAnchorMs(timelineRange.value, playhead.value), chartEndMs: endMs.value, viewRange: timelineRange.value, zoomDelta: direction * 0.5 });
}

function timelineControlKeydown(event: KeyboardEvent): void {
  if (event.key === "+" || event.key === "=") zoomTimeline(1);
  else if (event.key === "-") zoomTimeline(-1);
  else if (event.key === "0") timelineRange.value = fitTimelineViewRange(endMs.value);
  else return;
  event.preventDefault();
}

function workspaceKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey || busy.value || sourceLoading.value || props.active === false || selectionAnchor.value !== undefined) return;
  const target = event.target;
  if (target instanceof Element && target.closest("input, textarea, select, [contenteditable=true]")) return;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    if (calibrationId.value || drafts.value.length < 2) return;
    event.preventDefault();
    switchSectionTag(event.key === "ArrowLeft" ? -1 : 1);
    return;
  }
  if (transportDisabled.value) return;
  if (event.key === " ") {
    if (target instanceof Element && target.closest("button, a")) return;
    event.preventDefault();
    if (event.shiftKey) void playSelection();
    else void togglePlayback();
  } else if (event.key.toLowerCase() === "l") {
    event.preventDefault();
    void playSelection(true);
  }
}

function sectionIdentity(claim: ClaimV2): string {
  return `${claim.sectionId ?? `${claim.scope.startMs}-${claim.scope.endMs}`}:${resolvePlaybackRate(claim.playbackRate)}x`;
}

function sameSection(left: ClaimV2, right: ClaimV2): boolean {
  return resolvePlaybackRate(left.playbackRate) === resolvePlaybackRate(right.playbackRate)
    && (left.sectionId ? left.sectionId === right.sectionId
      : !right.sectionId && left.scope.startMs === right.scope.startMs && left.scope.endMs === right.scope.endMs);
}

function completeSection(claims: readonly ClaimV2[], anchor: ClaimV2): ClaimV2[] {
  return activeFoundation.value.tags.map(tag => {
    const existing = claims.find(claim => claim.tagId === tag.id);
    return existing ? JSON.parse(serializeCanonicalJson(existing)) : {
      id: crypto.randomUUID(), ...(anchor.sectionId ? { sectionId: anchor.sectionId } : {}),
      tagId: tag.id, playbackRate: resolvePlaybackRate(anchor.playbackRate),
      scope: { ...anchor.scope }, reviewContext: { ...anchor.reviewContext },
      assessment: { presence: "unreviewed" },
      evidence: { noteRefs: [...anchor.evidence.noteRefs], contextNoteRefs: [...anchor.evidence.contextNoteRefs], rationale: "" },
    };
  });
}

function draftKey(kind = editorOrigin.value === "proposal" && activeClaim.value ? `proposal:${activeHandoffId.value}:section:${sectionIdentity(activeClaim.value)}` : "direct", rate = resolvePlaybackRate(activeClaim.value?.playbackRate)): string {
  if (confidenceReviewActive.value) kind = `confidence:${activeConfidenceObservationIds.value.join(":")}`;
  if (kind === "direct" && rate !== 1) kind = `direct:${rate}x`;
  return `beatmap-lens-review-draft:${source.value?.source.sha256}:${stored.value?.document.documentId ?? "unbound"}:${activeFoundation.value.foundationId}:${activeFoundation.value.revision}:${kind}`;
}

function stashDraft(): void {
  if (sectionComplete.value || restoring.value || !source.value || !drafts.value.length || (!confidenceReviewActive.value && !["direct", "proposal"].includes(editorOrigin.value))) return;
  reviewDraftStorage.set(draftKey(), {
    drafts: drafts.value, evidenceReviews: evidenceReviews.value, savedEvidenceReviews: savedEvidenceReviews.value, confidences: confidences.value, savedConfidences: savedConfidences.value, activeClaimId: activeClaimId.value, editorOrigin: editorOrigin.value,
    activeHandoffId: activeHandoffId.value, decisionNote: decisionNote.value, base: editorBase.value, reviewRevision: editorReviewRevision.value, proposalEditing: proposalEditing.value,
  });
  draftStorageWarning.value = Object.keys(reviewDraftStorage.unsaved()).length > 0;
}

function restoreSection(): void {
  historicalObservation.value = undefined;
  stashDraft();
  confidenceReviewActive.value = false;
  const text = reviewDraftStorage.get(draftKey("direct", playbackRate.value));
  if (!text) { newSection(); return; }
  const saved = JSON.parse(text);
  drafts.value = saved.drafts;
  evidenceReviews.value = saved.evidenceReviews ?? Object.fromEntries(drafts.value.map(claim => [claim.id, newEvidenceReview("unknown")]));
  savedEvidenceReviews.value = {};
  confidences.value = saved.confidences ?? Object.fromEntries(drafts.value.map(claim => [claim.id, "low"]));
  savedConfidences.value = {};
  activeClaimId.value = saved.activeClaimId;
  editorOrigin.value = "direct";
  activeObservationId.value = "";
  sectionObservationIds.value = {};
  savedSectionDrafts.value = [];
  activeHandoffId.value = "";
  decisionNote.value = saved.decisionNote;
  editorBase.value = saved.base;
  editorReviewRevision.value = saved.reviewRevision;
}

watch(() => props.remoteSource, async (remote, _previous, onCleanup) => {
  if (!remote) return;
  let superseded = false;
  onCleanup(() => { superseded = true; });
  if (source.value?.source.sha256 !== remote.document.source.sha256) {
    stashDraft();
    sourceLoading.value = true;
    try {
      const bytes = Uint8Array.from(remote.sourceBytes);
      const inspected = await inspectOsuSourceV1(bytes);
      if (superseded) return;
      restoring.value = true;
      directory.value = createRemoteReviewStore(remote.document.source.sha256);
      directoryName.value = "Connected inbox";
      chartHistoryVersion.value = "";
      sourceBytes.value = bytes;
      source.value = inspected;
      foundation.value = remote.document.foundation;
      if (!humanId.value && remote.document.foundation.approval.status === "human-approved") humanId.value = remote.document.foundation.approval.humanId;
      stored.value = { document: remote.document, version: remote.version };
      pendingTask.value = undefined;
      calibrationId.value = "";
      timelineRange.value = { startMs: 0, endMs: chartEndMs(inspected.chart) };
      playhead.value = inspected.chart.notes[0]?.startMs ?? 0;
      restoreSection();
      openRequestedClaim();
      status.value = "Connected · changes save to workspace";
    } catch (cause) {
      if (!superseded) error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (!superseded) { restoring.value = false; sourceLoading.value = false; }
    }
  } else {
    sourceLoading.value = false;
    if (!stored.value || remote.version.revision > stored.value.version.revision) stored.value = { document: remote.document, version: remote.version };
    if (pendingOpenClaim) openRequestedClaim();
  }
}, { immediate: true });
watch(() => props.openClaim, openRequestedClaim);
watch(() => props.openHumanObservationIds, openRequestedClaim);

function openRequestedClaim(): void {
  if (props.openHumanObservationIds?.length) {
    pendingOpenClaim = true;
    if (!document.value || document.value.source.sha256 !== props.remoteSource?.document.source.sha256) return;
    openConfidenceObservations(props.openHumanObservationIds);
    pendingOpenClaim = false;
    return;
  }
  const target = props.openClaim;
  if (!target) return;
  pendingOpenClaim = true;
  if (!document.value) return;
  const claim = document.value.handoffs.find(entry => entry.handoff.handoffId === target.handoffId)?.handoff.proposals.find(claim => claim.id === target.claimId);
  if (claim) { openProposal(target.handoffId, claim); pendingOpenClaim = false; }
}

function openConfidenceObservations(ids: readonly string[]): void {
  const observations = ids.map(id => currentObservations.value.find(observation => observation.id === id));
  if (observations.some(observation => !observation)) {
    error.value = "A selected human judgment is no longer current. Return to the confidence queue to reload it.";
    return;
  }
  const targets = observations as HumanObservationV2[];
  const first = targets[0];
  if (!first) return;
  stashDraft();
  confidenceReviewActive.value = true;
  activeConfidenceObservationIds.value = [...ids];
  historicalObservation.value = undefined;
  sectionComplete.value = false;
  sectionProposals.value = targets.flatMap(observation => {
    const origin = observation.origin;
    return origin.kind === "agent-proposal" ? document.value?.handoffs.find(entry => entry.handoff.handoffId === origin.handoffId)?.handoff.proposals.filter(claim => claim.id === origin.claimId) ?? [] : [];
  });
  const agentOrigin = targets.find(observation => observation.origin.kind === "agent-proposal")?.origin;
  activeHandoffId.value = agentOrigin?.kind === "agent-proposal" ? agentOrigin.handoffId : "";
  editorOrigin.value = agentOrigin ? "proposal" : "observation";
  activeObservationId.value = first.id;
  sectionObservationIds.value = Object.fromEntries(targets.filter(observation => observation.origin.kind === "direct-human").map(observation => [observation.claim.id, observation.id]));
  drafts.value = JSON.parse(serializeCanonicalJson(targets.map(observation => observation.claim)));
  savedSectionDrafts.value = drafts.value;
  evidenceReviews.value = Object.fromEntries(targets.map(observation => [observation.claim.id, inheritedHumanEvidenceReview(observation)]));
  savedEvidenceReviews.value = { ...evidenceReviews.value };
  confidences.value = Object.fromEntries(targets.map(observation => [observation.claim.id, observation.confidence]));
  savedConfidences.value = { ...confidences.value };
  activeClaimId.value = first.claim.id;
  proposalEditing.value = true;
  decisionNote.value = "";
  editorBase.value = stored.value?.version;
  editorReviewRevision.value = document.value?.reviewRevision;
  calibrationId.value = "";
  const cached = reviewDraftStorage.get(draftKey());
  const saved = cached ? JSON.parse(cached) : undefined;
  if (saved?.reviewRevision === document.value?.reviewRevision) {
    drafts.value = saved.drafts;
    confidences.value = saved.confidences;
    evidenceReviews.value = saved.evidenceReviews;
    decisionNote.value = saved.decisionNote ?? "";
  }
  focus(first.claim.reviewContext);
}

watch(humanId, value => {
  try { localStorage.setItem("beatmap-lens-review-human", value); } catch { /* The current reviewer remains available for submission. */ }
});
watch([drafts, evidenceReviews, confidences, activeClaimId, editorOrigin, activeHandoffId, decisionNote], stashDraft, { deep: true, flush: "post" });
watch(activeClaimId, () => {
  notePage.value = 0;
  if (editorOrigin.value === "observation" && !historicalObservation.value) activeObservationId.value = sectionObservationIds.value[activeClaimId.value] ?? "";
});
watch(document, async current => {
  if (!current) { handoffStatuses.value = {}; agentReviews.value = []; return; }
  const reviews = await readAgentReviewsV2(current);
  const statuses = Object.fromEntries(reviews.map(review => [review.handoffId, review.baseStatus]));
  for (const { handoff } of current.handoffs) {
    if (!(handoff.handoffId in statuses)) statuses[handoff.handoffId] = await handoffBaseStatusV2(current, handoff.handoffId);
  }
  if (document.value === current) { handoffStatuses.value = statuses; agentReviews.value = reviews; }
});

async function run(action: () => Promise<void>): Promise<void> {
  if (busy.value || sourceLoading.value) return;
  busy.value = true;
  error.value = "";
  try { await action(); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { busy.value = false; }
}

async function initialize(): Promise<void> {
  if (!directory.value || !sourceBytes.value) return;
  stored.value = await directory.value.initialize(sourceBytes.value, { ...foundation.value, approval: { status: "proposed" } });
  if (pendingTask.value) {
    stored.value = await directory.value.registerTask(sourceBytes.value, stored.value.version, pendingTask.value);
    pendingTask.value = undefined;
  }
  status.value = `Saved workspace · revision ${stored.value.document.revision}`;
}

async function loadSource(bytes: Uint8Array, task?: TaskPacketV2): Promise<void> {
  const inspected = await inspectOsuSourceV1(bytes);
  stashDraft();
  restoring.value = true;
  drafts.value = [];
  activeClaimId.value = "";
  calibrationId.value = "";
  source.value = inspected;
  chartHistoryVersion.value = "";
  sourceBytes.value = bytes;
  stored.value = undefined;
  pendingTask.value = task;
  if (task) foundation.value = task.foundation;
  timelineRange.value = { startMs: 0, endMs: chartEndMs(inspected.chart) };
  playhead.value = inspected.chart.notes[0]?.startMs ?? 0;
  try {
    if (directory.value) await initialize();
    restoreSection();
  } finally { restoring.value = false; }
  status.value = stored.value ? `Reopened · ${document.value?.observations.length} observations · ${document.value?.decisions.length} decisions` : "Choose a workspace folder to save and exchange tasks.";
}

function openFiles(event: Event): void {
  const selected = Array.from((event.target as HTMLInputElement).files ?? []);
  void run(async () => {
    files.value = selected;
    selectedFile.value = 0;
    const file = selected[0];
    if (file) await loadSource(new Uint8Array(await file.arrayBuffer()));
  });
}

function changeDifficulty(): void {
  void run(async () => {
    const file = files.value[selectedFile.value];
    if (file) await loadSource(new Uint8Array(await file.arrayBuffer()));
  });
}

function chooseDirectory(): void {
  void run(async () => {
    const handle = await pickDatasetDirectory();
    stashDraft();
    restoring.value = true;
    directory.value = new WorkflowDirectoryV2(handle);
    directoryName.value = handle.name;
    stored.value = undefined;
    drafts.value = [];
    try { await initialize(); restoreSection(); }
    finally { restoring.value = false; }
  });
}

function importJson(event: Event, kind: "task" | "handoff" | "audit" | "foundation"): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  void run(async () => {
    const value: unknown = JSON.parse(await file.text());
    if (kind === "task") {
      await assertTaskPacketV2(value);
      const task = value as TaskPacketV2;
      await loadSource(Uint8Array.from(task.sourceBytes), task);
    } else if (kind === "foundation") {
      if (!directory.value || !sourceBytes.value || !stored.value) throw new Error("Choose a source and workspace folder first.");
      stored.value = await directory.value.replaceProposedFoundation(sourceBytes.value, stored.value.version, value as FoundationV2);
      foundation.value = stored.value.document.foundation;
      status.value = "Calibration proposal loaded. Review definitions and every example before approving.";
      newSection();
    } else if (kind === "audit") {
      if (!directory.value || !sourceBytes.value || !stored.value) throw new Error("Choose a source and workspace folder first.");
      const result = await directory.value.importAudit(sourceBytes.value, stored.value.version, value);
      stored.value = result.stored;
      const reviews = await readAgentReviewsV2(result.stored.document);
      const expert = reviews.find(review => review.status === "needs-expert");
      status.value = `${result.status} independent audit · ${reviews.filter(review => review.status === "needs-expert").length} expert cases · ${reviews.filter(review => review.status === "agent-reviewed").length} agent-reviewed`;
      if (expert) openProposal(expert.handoffId, expert.claim);
    } else {
      if (!directory.value || !sourceBytes.value || !stored.value) throw new Error("Choose a source and workspace folder first.");
      const result = await directory.value.importHandoff(sourceBytes.value, stored.value.version, value);
      stored.value = result.stored;
      status.value = `${result.status} · task base ${result.baseStatus} · independent audit pending`;
      const id = (value as { handoffId: string }).handoffId;
      const handoff = result.stored.document.handoffs.find(entry => entry.handoff.handoffId === id)?.handoff;
      if (handoff?.proposals[0]) openProposal(handoff.handoffId, handoff.proposals[0]);
    }
  });
}

function download(name: string, value: unknown): void {
  const url = URL.createObjectURL(new Blob([serializeCanonicalJson(value)], { type: "application/json" }));
  const link = window.document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportTask(): void {
  void run(async () => {
    if (!directory.value || !sourceBytes.value || !stored.value) return;
    const result = await directory.value.exportTask(sourceBytes.value, stored.value.version);
    stored.value = result.stored;
    download(`task-${result.task.taskId}.json`, result.task);
    status.value = "Frozen task exported with the full difficulty, exact source and Foundation.";
  });
}

function exportDecisions(): void {
  void run(async () => {
    if (!stored.value) return;
    const dispositions = await readDispositionsV2(stored.value.document);
    download(`dispositions-${stored.value.document.source.sha256.slice(0, 12)}.json`, dispositions);
    status.value = "Human dispositions and separate machine review states exported.";
  });
}

function approveFoundation(): void {
  void run(async () => {
    if (!directory.value || !sourceBytes.value || !stored.value) return;
    stored.value = await directory.value.approveFoundation(sourceBytes.value, stored.value.version, humanId.value);
    status.value = "Foundation and calibration examples approved by the named human.";
  });
}

function newSection(): void {
  stashDraft();
  confidenceReviewActive.value = false;
  historicalObservation.value = undefined;
  const sectionId = crypto.randomUUID();
  const startMs = Math.max(0, Math.min(playhead.value, endMs.value - 1));
  const scope = { startMs, endMs: Math.min(endMs.value, startMs + 4000) };
  drafts.value = activeFoundation.value.tags.map(tag => ({
    id: crypto.randomUUID(), sectionId, tagId: tag.id, playbackRate: playbackRate.value, scope,
    reviewContext: { startMs: Math.max(0, scope.startMs - 2000), endMs: Math.min(endMs.value, scope.endMs + 1000) },
    assessment: { presence: "unreviewed" }, evidence: { noteRefs: [], contextNoteRefs: [], rationale: "" },
  }));
  evidenceReviews.value = Object.fromEntries(drafts.value.map(claim => [claim.id, newEvidenceReview("new-human")]));
  savedEvidenceReviews.value = {};
  confidences.value = Object.fromEntries(drafts.value.map(claim => [claim.id, "low"]));
  savedConfidences.value = {};
  activeClaimId.value = drafts.value[0]?.id ?? "";
  editorOrigin.value = "direct";
  activeObservationId.value = "";
  sectionObservationIds.value = {};
  savedSectionDrafts.value = [];
  activeHandoffId.value = "";
  decisionNote.value = "";
  editorBase.value = stored.value?.version;
  editorReviewRevision.value = document.value?.reviewRevision;
  calibrationId.value = "";
}

function overlapsNote(note: StableNoteRefV1, range: TimeRangeV1): boolean {
  return note.startMs < range.endMs && (note.kind === "long" ? note.endMs > range.startMs : note.startMs >= range.startMs);
}

function atSectionRange(claim: ClaimV2, scope: TimeRangeV1, reviewContext: TimeRangeV1): ClaimV2 {
  const noteRefs = claim.evidence.noteRefs.filter(note => overlapsNote(note, scope));
  const displaced = claim.evidence.noteRefs.filter(note => !overlapsNote(note, scope));
  const contextNoteRefs = [...new Map([...claim.evidence.contextNoteRefs, ...displaced].filter(note => overlapsNote(note, reviewContext)).map(note => [stableNoteRefKey(note), note])).values()];
  const { transition, boundaryUncertainty, ...base } = claim;
  const start = boundaryUncertainty?.start;
  const end = boundaryUncertainty?.end;
  const boundary = {
    ...(start && scope.startMs >= start.startMs && scope.startMs <= start.endMs ? { start } : {}),
    ...(end && scope.endMs >= end.startMs && scope.endMs <= end.endMs ? { end } : {}),
  };
  return { ...base, scope: { ...scope }, reviewContext: { ...reviewContext }, evidence: { ...claim.evidence, noteRefs, contextNoteRefs },
    ...(transition && transition.range.startMs >= scope.startMs && transition.range.endMs <= scope.endMs ? { transition } : {}),
    ...(Object.keys(boundary).length ? { boundaryUncertainty: boundary } : {}),
  };
}

function sameLabelJudgment(left: ClaimV2, right: ClaimV2): boolean {
  return serializeCanonicalJson(left.assessment) === serializeCanonicalJson(right.assessment)
    && serializeCanonicalJson(left.scope) === serializeCanonicalJson(right.scope)
    && left.tagId === right.tagId && resolvePlaybackRate(left.playbackRate) === resolvePlaybackRate(right.playbackRate);
}

function updateClaim(claim: ClaimV2): void {
  if (!canEdit.value) return;
  playback?.pause();
  const previous = drafts.value.find(current => current.id === claim.id);
  const rangeChanged = previous && (serializeCanonicalJson(previous.scope) !== serializeCanonicalJson(claim.scope)
    || serializeCanonicalJson(previous.reviewContext) !== serializeCanonicalJson(claim.reviewContext));
  const reviews = { ...evidenceReviews.value };
  const confidenceDraft = { ...confidences.value };
  drafts.value = drafts.value.map(current => {
    const candidate = current.id === claim.id ? claim : current;
    const next = rangeChanged ? atSectionRange(candidate, claim.scope, claim.reviewContext) : candidate;
    let review = reviews[current.id] ?? newEvidenceReview("unknown");
    if (rangeChanged) review = recordEvidenceOperation(review, { kind: "range-filter", target: "both" });
    const updated = updateEvidenceDraft(current, next, review);
    if (!sameLabelJudgment(current, next)) confidenceDraft[current.id] = "low";
    reviews[current.id] = updated.review;
    return updated.claim;
  });
  evidenceReviews.value = reviews;
  confidences.value = confidenceDraft;
  sectionComplete.value = false;
}

function updateConfidence(claimId: string, confidence: HumanConfidenceV2): void {
  if (!canEdit.value || !drafts.value.some(claim => claim.id === claimId && settled(claim))) return;
  confidences.value = { ...confidences.value, [claimId]: confidence };
  sectionComplete.value = false;
}

function confidenceLabel(confidence: HumanConfidenceV2 | undefined): string {
  return confidence === "high" ? "High confidence" : confidence === "low" ? "Low confidence" : "Confidence not specified";
}

function updateEditorClaim(claim: ClaimV2): void {
  const previous = drafts.value.find(entry => entry.id === claim.id);
  updateClaim(claim);
  for (const key of ["noteRefs", "contextNoteRefs"] as const) {
    if (previous && serializeCanonicalJson(previous.evidence[key]) !== serializeCanonicalJson(claim.evidence[key]))
      recordSelectionOperation(claim.id, "manual-note-edit", key === "noteRefs" ? "witness" : "context");
  }
}

function updateSectionAssessment(claim: ClaimV2): void {
  activeClaimId.value = claim.id;
  const noteRefs = claim.evidence.noteRefs.length ? claim.evidence.noteRefs : noteIndex.value.notesInRange(claim.scope).map(createStableNoteRefV1);
  updateClaim({ ...claim, evidence: { ...claim.evidence, noteRefs } });
  if (!claim.evidence.noteRefs.length && noteRefs.length) recordSelectionOperation(claim.id, "auto-scope-fill", "witness");
}

function recordSelectionOperation(claimId: string, kind: EvidenceReviewV2["operations"][number]["kind"], target: EvidenceReviewV2["operations"][number]["target"]): void {
  evidenceReviews.value = { ...evidenceReviews.value, [claimId]: recordEvidenceOperation(evidenceReviews.value[claimId] ?? newEvidenceReview("unknown"), { kind, target }) };
  sectionComplete.value = false;
}

function focus(range: TimeRangeV1): void {
  if (activeClaim.value) setPlaybackRate(resolvePlaybackRate(activeClaim.value.playbackRate));
  playback?.pause();
  seekPlayhead(range.startMs);
  mobilePanel.value = "preview";
}

function openProposal(handoffId: string, claim: ClaimV2, keepViewport = false): void {
  stashDraft();
  confidenceReviewActive.value = false;
  historicalObservation.value = undefined;
  sectionComplete.value = false;
  const proposals = document.value?.handoffs.find(entry => entry.handoff.handoffId === handoffId)?.handoff.proposals.filter(current => sameSection(claim, current)) ?? [claim];
  sectionProposals.value = proposals;
  const observations = currentObservations.value;
  const siblings = proposals.map(proposal => {
    const decision = document.value?.decisions.filter(entry => entry.handoffId === handoffId && entry.claimId === proposal.id).at(-1);
    return document.value?.observations.find(entry => entry.id === decision?.observationId)?.claim ?? proposal;
  });
  const completionId = (tagId: string) => `section-completion:${handoffId}:${sectionIdentity(claim)}:${tagId}`;
  const additions = observations.filter(entry => entry.origin.kind === "direct-human" && entry.claim.id === completionId(entry.claim.tagId)
    && !proposals.some(proposal => proposal.tagId === entry.claim.tagId));
  const latest = document.value?.decisions.filter(entry => entry.handoffId === handoffId && proposals.some(proposal => proposal.id === entry.claimId) && entry.observationId).at(-1);
  const anchor = document.value?.observations.find(entry => entry.id === latest?.observationId)?.claim ?? claim;
  const originals = completeSection([...siblings, ...additions.map(entry => entry.claim)], anchor).map(entry => ({
    ...entry, id: proposals.some(proposal => proposal.tagId === entry.tagId) ? entry.id : completionId(entry.tagId),
  }));
  const current = originals.map(entry => updateEvidenceDraft(entry, atSectionRange(entry, anchor.scope, anchor.reviewContext), newEvidenceReview("unknown")).claim);
  const key = draftKey(`proposal:${handoffId}:section:${sectionIdentity(claim)}`);
  const cached = reviewDraftStorage.get(key) ?? reviewDraftStorage.get(draftKey(`proposal:${handoffId}:${claim.id}`));
  const saved = cached ? JSON.parse(cached) : undefined;
  const currentDraft = saved?.reviewRevision === document.value?.reviewRevision ? saved : undefined;
  drafts.value = currentDraft ? current.map(entry => currentDraft.drafts.find((draft: ClaimV2) => draft.tagId === entry.tagId) ?? entry) : current;
  const initialReviews = Object.fromEntries(current.map(entry => {
    const human = additions.find(observation => observation.claim.id === entry.id) ?? observations.find(observation => observation.claim.id === entry.id && observation.origin.kind === "agent-proposal" && observation.origin.handoffId === handoffId);
    const review = human ? inheritedHumanEvidenceReview(human)
      : proposals.some(proposal => proposal.id === entry.id) ? newEvidenceReview("inherited-agent", { sourceHandoffId: handoffId, sourceClaimId: entry.id })
      : newEvidenceReview("copied-section", { sourceClaimId: anchor.id });
    const prior = originals.find(original => original.id === entry.id);
    const rangeAdjusted = prior && (serializeCanonicalJson(prior.scope) !== serializeCanonicalJson(entry.scope)
      || serializeCanonicalJson(prior.reviewContext) !== serializeCanonicalJson(entry.reviewContext));
    return [entry.id, rangeAdjusted ? recordEvidenceOperation(review, { kind: "range-filter", target: "both" }) : review];
  }));
  evidenceReviews.value = currentDraft ? currentDraft.evidenceReviews ?? Object.fromEntries(current.map(entry => [entry.id, newEvidenceReview("unknown")])) : initialReviews;
  savedEvidenceReviews.value = currentDraft ? currentDraft.savedEvidenceReviews ?? evidenceReviews.value : initialReviews;
  const humanForClaim = (entry: ClaimV2) => additions.find(observation => observation.claim.id === entry.id) ?? observations.find(observation => observation.claim.id === entry.id && observation.origin.kind === "agent-proposal" && observation.origin.handoffId === handoffId);
  const persistedConfidences = Object.fromEntries(current.map(entry => {
    const human = humanForClaim(entry);
    return [entry.id, human ? human.confidence : "low"];
  }));
  const initialConfidences = Object.fromEntries(drafts.value.map(entry => {
    const human = humanForClaim(entry);
    return [entry.id, human && sameLabelJudgment(human.claim, entry) ? human.confidence : "low"];
  }));
  confidences.value = currentDraft?.confidences ?? initialConfidences;
  savedConfidences.value = currentDraft?.savedConfidences ?? persistedConfidences;
  savedSectionDrafts.value = current;
  activeClaimId.value = drafts.value.find(entry => entry.tagId === claim.tagId)?.id ?? drafts.value[0]?.id ?? "";
  activeHandoffId.value = handoffId;
  editorOrigin.value = "proposal";
  activeObservationId.value = "";
  sectionObservationIds.value = Object.fromEntries(additions.map(entry => [entry.claim.id, entry.id]));
  proposalEditing.value = true;
  decisionNote.value = currentDraft?.decisionNote ?? "";
  editorBase.value = currentDraft?.base ?? stored.value?.version;
  editorReviewRevision.value = currentDraft?.reviewRevision ?? document.value?.reviewRevision;
  calibrationId.value = "";
  if (!keepViewport) focus(activeClaim.value?.reviewContext ?? claim.reviewContext);
}


function openObservation(observation: HumanObservationV2): void {
  if (observation.origin.kind === "agent-proposal") {
    openQuestion(observation.origin.handoffId, observation.origin.claimId);
    return;
  }
  for (const { handoff } of document.value?.handoffs ?? []) {
    const anchor = handoff.proposals.find(claim => observation.claim.id === `section-completion:${handoff.handoffId}:${sectionIdentity(claim)}:${observation.claim.tagId}`);
    if (anchor) {
      openProposal(handoff.handoffId, anchor);
      activeClaimId.value = drafts.value.find(claim => claim.tagId === observation.claim.tagId)?.id ?? activeClaimId.value;
      return;
    }
  }
  stashDraft();
  confidenceReviewActive.value = false;
  historicalObservation.value = undefined;
  const current = currentObservations.value.find(entry => {
    let candidate: HumanObservationV2 | undefined = entry;
    while (candidate) {
      if (candidate.id === observation.id) return true;
      const priorId: string | undefined = candidate.supersedesObservationId;
      candidate = document.value?.observations.find(item => item.id === priorId);
    }
    return false;
  }) ?? observation;
  const siblings = currentObservations.value.filter(entry => entry.origin.kind === "direct-human" && sameSection(entry.claim, current.claim));
  drafts.value = completeSection(siblings.map(entry => entry.claim), current.claim);
  evidenceReviews.value = Object.fromEntries(drafts.value.map(claim => {
    const prior = siblings.find(entry => entry.claim.id === claim.id);
    return [claim.id, prior ? inheritedHumanEvidenceReview(prior) : newEvidenceReview("copied-section", { sourceClaimId: current.claim.id })];
  }));
  savedEvidenceReviews.value = { ...evidenceReviews.value };
  confidences.value = Object.fromEntries(drafts.value.map(claim => {
    const prior = siblings.find(entry => entry.claim.id === claim.id);
    return [claim.id, prior ? prior.confidence : "low"];
  }));
  savedConfidences.value = { ...confidences.value };
  savedSectionDrafts.value = JSON.parse(serializeCanonicalJson(drafts.value));
  sectionObservationIds.value = Object.fromEntries(siblings.map(entry => [entry.claim.id, entry.id]));
  activeObservationId.value = current.id;
  editorBase.value = stored.value?.version;
  editorReviewRevision.value = document.value?.reviewRevision;
  activeClaimId.value = current.claim.id;
  editorOrigin.value = "observation";
  activeHandoffId.value = "";
  calibrationId.value = "";
  sectionComplete.value = false;
  focus(current.claim.reviewContext);
}

function openHistoricalObservation(observation: HumanObservationV2 | undefined): void {
  if (!observation) return;
  stashDraft();
  historicalObservation.value = observation;
  drafts.value = [JSON.parse(serializeCanonicalJson(observation.claim))];
  evidenceReviews.value = { [observation.claim.id]: observation.evidenceReview ?? newEvidenceReview("unknown") };
  confidences.value = { [observation.claim.id]: observation.confidence };
  activeClaimId.value = observation.claim.id;
  activeObservationId.value = observation.id;
  activeHandoffId.value = "";
  editorOrigin.value = "observation";
  calibrationId.value = "";
  focus(observation.claim.reviewContext);
}

function reviseFromHistoricalObservation(): void {
  const prior = historicalObservation.value;
  if (!prior) return;
  openObservation(prior);
  const current = drafts.value.find(claim => claim.tagId === prior.claim.tagId);
  if (current) {
    evidenceReviews.value = { ...evidenceReviews.value, [current.id]: inheritedHumanEvidenceReview(prior) };
    updateClaim({ ...JSON.parse(serializeCanonicalJson(prior.claim)), id: current.id });
  }
  proposalEditing.value = true;
  focus(prior.claim.reviewContext);
}

function decisionObservation(observationId: string | undefined): HumanObservationV2 | undefined {
  return document.value?.observations.find(entry => entry.id === observationId);
}

function toggleNote(noteId: string): void {
  if (!canEdit.value || !activeClaim.value) return;
  const note = source.value?.chart.notes.find(note => note.id === noteId);
  if (!note) return;
  const ref = createStableNoteRefV1(note);
  const key = evidenceMode.value;
  const refs = activeClaim.value.evidence[key];
  const next = refs.some(item => stableNoteRefKey(item) === stableNoteRefKey(ref))
    ? refs.filter(item => stableNoteRefKey(item) !== stableNoteRefKey(ref)) : [...refs, ref];
  updateClaim({ ...activeClaim.value, evidence: { ...activeClaim.value.evidence, [key]: next } });
  recordSelectionOperation(activeClaimId.value, "manual-note-edit", key === "noteRefs" ? "witness" : "context");
}

function selectScopeNotes(): void {
  if (!canEdit.value || !source.value || !activeClaim.value) return;
  const range = activeClaim.value.scope;
  const noteRefs: StableNoteRefV1[] = source.value.chart.notes.filter(note => note.startMs < range.endMs && (note.kind === "long" ? note.endMs > range.startMs : note.startMs >= range.startMs)).map(createStableNoteRefV1);
  updateClaim({ ...activeClaim.value, evidence: { ...activeClaim.value.evidence, noteRefs } });
  recordSelectionOperation(activeClaimId.value, "explicit-scope-selection", "witness");
}

function beginRange(anchorMs: number, kind = "select"): void {
  playback?.pause();
  selectionAnchor.value = anchorMs;
  gestureClaim.value = activeClaim.value;
  gestureDrafts.value = drafts.value;
  gestureEvidenceReviews.value = evidenceReviews.value;
  gestureConfidences.value = confidences.value;
  gestureEdge.value = kind;
}

function cancelRange(): void {
  if (gestureDrafts.value) drafts.value = gestureDrafts.value;
  if (gestureEvidenceReviews.value) evidenceReviews.value = gestureEvidenceReviews.value;
  if (gestureConfidences.value) confidences.value = gestureConfidences.value;
  gestureEvidenceReviews.value = undefined;
  gestureConfidences.value = undefined;
  gestureClaim.value = undefined;
  gestureDrafts.value = undefined;
  selectionAnchor.value = undefined;
}

function dragRange(timeMs: number): void {
  if (!canEdit.value || !activeClaim.value || selectionAnchor.value === undefined) return;
  const before = gestureClaim.value?.scope ?? activeClaim.value.scope;
  const delta = timeMs - selectionAnchor.value;
  const kind = gestureEdge.value;
  const startMs = kind === "move-range" ? before.startMs + delta : kind === "resize-end" ? before.startMs : kind === "resize-start" ? timeMs : Math.min(selectionAnchor.value, timeMs);
  const endMs = kind === "move-range" ? before.endMs + delta : kind === "resize-start" ? before.endMs : kind === "resize-end" ? timeMs : Math.max(selectionAnchor.value, timeMs);
  if (endMs > startMs) updateClaim({ ...activeClaim.value, scope: { startMs, endMs }, reviewContext: {
    startMs: Math.min(activeClaim.value.reviewContext.startMs, startMs), endMs: Math.max(activeClaim.value.reviewContext.endMs, endMs),
  } });
}


function saveSection(): void {
  void submitSection(false);
}

function decideSection(): void {
  void submitSection(true);
}

async function submitSection(proposal: boolean): Promise<void> {
  if (!claimRateMatchesPlayback.value || busy.value || sourceLoading.value || savingDecision.value || !directory.value || !sourceBytes.value || !stored.value || !activeClaim.value || !humanId.value.trim()) return;
  if (draftIsStale.value || (proposal && !sectionReady.value)) return;
  const sourceSha = stored.value.document.source.sha256;
  const anchorId = activeClaim.value.id;
  const handoffId = activeHandoffId.value;
  const key = proposal || editorOrigin.value === "direct" || confidenceReviewActive.value ? draftKey() : undefined;
  const snapshot = JSON.parse(serializeCanonicalJson(drafts.value)) as ClaimV2[];
  const reviewSnapshot = JSON.parse(serializeCanonicalJson(evidenceReviews.value)) as Record<string, EvidenceReviewV2>;
  const confidenceSnapshot = { ...confidences.value };
  const reviewChanged = (claimId: string) => serializeCanonicalJson(reviewSnapshot[claimId]) !== serializeCanonicalJson(savedEvidenceReviews.value[claimId]);
  const confidenceChanged = (claimId: string) => confidenceSnapshot[claimId] !== savedConfidences.value[claimId];
  const storedBefore = stored.value;
  const sameClaim = (left: ClaimV2, right: ClaimV2) => serializeCanonicalJson(left) === serializeCanonicalJson(right);
  const observations = snapshot.filter(claim => claim.assessment.presence !== "unreviewed"
    && (!proposal || !sectionProposals.value.some(original => original.id === claim.id))
    && (!sectionObservationIds.value[claim.id] || !savedSectionDrafts.value.some(saved => saved.id === claim.id && sameClaim(saved, claim) && !reviewChanged(claim.id) && !confidenceChanged(claim.id))));
  const supersedesObservationIds = Object.fromEntries(observations.flatMap(claim => {
    const priorId = sectionObservationIds.value[claim.id];
    return priorId ? [[claim.id, priorId]] : [];
  }));
  const decisions = proposal ? snapshot.flatMap(claim => {
    const original = sectionProposals.value.find(entry => entry.id === claim.id);
    if (!original) return [];
    const prior = storedBefore.document.decisions.filter(entry => entry.handoffId === handoffId && entry.claimId === claim.id).at(-1);
    const previous = storedBefore.document.observations.find(entry => entry.id === prior?.observationId)?.claim;
    if (previous && sameClaim(previous, claim) && !reviewChanged(claim.id) && !confidenceChanged(claim.id)) return [];
    const accepted = sameClaim(original, claim) && activeTrust.value?.foundation !== "changed";
    const confidence = confidenceSnapshot[claim.id];
    const confidenceOnly = previous && sameClaim(previous, claim) && !reviewChanged(claim.id) && confidenceChanged(claim.id);
    return [{ handoffId, claimId: claim.id, disposition: accepted ? "accepted" as const : "modified" as const,
      evidenceReview: reviewSnapshot[claim.id] ?? newEvidenceReview("unknown"),
      ...(confidence ? { confidence } : {}),
      rationale: decisionNote.value.trim() || (confidenceOnly ? "Human updated label confidence." : accepted ? "Human confirmed the original proposal." : "Human revised the section assessments."),
      ...(!accepted ? { modifiedClaim: claim } : {}) }];
  }) : [];
  if (!observations.length && !decisions.length) { status.value = "All section judgments are already saved."; return; }
  stashDraft();
  savingDecision.value = { sourceSha, handoffId, claimId: anchorId };
  error.value = "";
  try {
    const input = { humanId: humanId.value, confidences: Object.fromEntries(observations.flatMap(claim => confidenceSnapshot[claim.id] ? [[claim.id, confidenceSnapshot[claim.id] as HumanConfidenceV2]] : [])), evidenceReviews: Object.fromEntries(observations.map(claim => [claim.id, reviewSnapshot[claim.id] ?? newEvidenceReview("unknown")])), ...(Object.keys(supersedesObservationIds).length ? { supersedesObservationIds } : {}) };
    const saved = proposal
      ? await directory.value.decideSection(sourceBytes.value, storedBefore.version, { ...input, decisions, observations })
      : await directory.value.addObservations(sourceBytes.value, storedBefore.version, { ...input, claims: observations });
    if (source.value?.source.sha256 === sourceSha) {
      if (!stored.value || saved.version.revision >= stored.value.version.revision) stored.value = saved;
      const sameEditor = activeHandoffId.value === handoffId && drafts.value.some(claim => claim.id === anchorId);
      if (sameEditor) {
        const effectiveDirect = effectiveHumanObservationsV2(saved.document).filter(entry => entry.origin.kind === "direct-human");
        const savedClaims = snapshot.map(claim => {
          if (proposal && sectionProposals.value.some(entry => entry.id === claim.id)) {
            const decision = saved.document.decisions.filter(entry => entry.handoffId === handoffId && entry.claimId === claim.id).at(-1);
            return saved.document.observations.find(entry => entry.id === decision?.observationId)?.claim ?? claim;
          }
          return effectiveDirect.find(entry => entry.claim.id === claim.id)?.claim ?? claim;
        });
        const unchangedDuringSave = sameClaimList(snapshot, drafts.value) && serializeCanonicalJson(reviewSnapshot) === serializeCanonicalJson(evidenceReviews.value) && serializeCanonicalJson(confidenceSnapshot) === serializeCanonicalJson(confidences.value);
        savedEvidenceReviews.value = reviewSnapshot;
        savedConfidences.value = confidenceSnapshot;
        if (unchangedDuringSave) drafts.value = JSON.parse(serializeCanonicalJson(savedClaims));
        savedSectionDrafts.value = JSON.parse(serializeCanonicalJson(savedClaims));
        const direct = effectiveHumanObservationsV2(saved.document).filter(entry => entry.origin.kind === "direct-human" && drafts.value.some(claim => claim.id === entry.claim.id));
        sectionObservationIds.value = Object.fromEntries(direct.map(entry => [entry.claim.id, entry.id]));
        if (!proposal) {
          editorOrigin.value = "observation";
          activeObservationId.value = direct.find(entry => entry.claim.id === activeClaimId.value)?.id ?? "";
        }
        editorBase.value = saved.version;
        editorReviewRevision.value = saved.document.reviewRevision;
        sectionComplete.value = unchangedDuringSave;
        status.value = unchangedDuringSave ? "Section judgments saved together." : "Section saved. Your newer edits are ready to submit.";
        if (unchangedDuringSave && key) {
          reviewDraftStorage.remove(key);
          draftStorageWarning.value = Object.keys(reviewDraftStorage.unsaved()).length > 0;
        }
        else stashDraft();
      }
    }
    emit("saved");
  } catch (cause) {
    status.value = "Section not saved · all draft judgments retained";
    error.value = cause instanceof Error ? cause.message : String(cause);
    stashDraft();
  } finally {
    savingDecision.value = undefined;
  }
}

function sameClaimList(left: readonly ClaimV2[], right: readonly ClaimV2[]): boolean {
  return serializeCanonicalJson(left) === serializeCanonicalJson(right);
}

function switchSectionTag(direction: -1 | 1): void {
  if (sourceLoading.value || drafts.value.length < 2) return;
  const index = drafts.value.findIndex(claim => claim.id === activeClaimId.value);
  activeClaimId.value = drafts.value[(index + direction + drafts.value.length) % drafts.value.length]?.id ?? "";
}

function latestDecision(handoffId: string, claimId: string): string {
  const review = agentReviews.value.find(review => review.handoffId === handoffId && review.claimId === claimId);
  const observation = document.value?.observations.find(entry => entry.id === review?.decision?.observationId);
  return observation && !settled(observation.claim) ? `${review?.status} · ${observation.claim.assessment.presence}` : review?.status ?? "awaiting-audit";
}

function settled(claim: ClaimV2 | undefined): boolean {
  return claim?.assessment.presence === "present" || claim?.assessment.presence === "absent";
}

function playbackDurationSeconds(range: TimeRangeV1, rate?: number): string {
  return ((range.endMs - range.startMs) / resolvePlaybackRate(rate) / 1000).toFixed(3);
}

function assessmentLabel(claim: ClaimV2): string {
  return claim.assessment.presence === "present" ? `present · ${claim.assessment.salience}` : claim.assessment.presence;
}

function communityAlignments(tag: FoundationTagV2): readonly CommunityAlignmentV2[] {
  return tag.communityAlignment ? [tag.communityAlignment] : tag.communityAlignments ?? [];
}

function openQuestion(handoffId: string, claimId: string): void {
  const claim = document.value?.handoffs.find(entry => entry.handoff.handoffId === handoffId)?.handoff.proposals.find(claim => claim.id === claimId);
  if (claim) openProposal(handoffId, claim);
}

function reload(): void {
  void run(async () => {
    if (!directory.value || !source.value) return;
    stored.value = await directory.value.read(source.value.source.sha256, sourceBytes.value) ?? undefined;
    status.value = "Canonical workspace reloaded. Editor draft retained.";
  });
}

onMounted(() => window.addEventListener("keydown", workspaceKeydown));
onBeforeUnmount(() => { window.removeEventListener("keydown", workspaceKeydown); stashDraft(); playback?.dispose(); });
</script>

<template>
  <main class="review-workspace" :class="{ 'has-source': source }">
    <WorkspaceFrame
      v-model:mobile-panel="mobilePanel"
      layout-key="review"
      :left="sourcePane"
      :right="judgmentPane"
      mobile-label="Review view"
    >
      <template #mode>
        <template v-if="remoteSource">
          <InboxNavigation v-if="$slots.navigation" />
          <button v-else type="button" class="tool-button" @click="emit('back-to-inbox')">← Back to inbox</button>
        </template>
        <WorkspaceModeSwitch v-else model-value="review" :disabled="busy || sourceLoading" @update:model-value="emit('change-mode', $event)" />
      </template>
      <template #toolbar>
        <div v-if="source" class="toolbar-identity toolbar-optional">
          <strong>{{ source.source.title }}</strong>
          <span>{{ source.source.artist }} · {{ source.source.difficulty }}</span>
        </div>
        <template v-if="source">
          <span class="toolbar-divider" aria-hidden="true"></span>
          <section class="review-transport toolbar-group" aria-label="Playback controls">
            <button type="button" class="tool-button tool-button--play review-primary" :aria-pressed="playing" :disabled="transportDisabled" @click="togglePlayback">{{ playing ? 'Pause' : 'Play' }} <kbd>Space</kbd></button>
            <button type="button" class="tool-button" :disabled="transportDisabled || !activeClaim" @click="playSelection()">Selection <kbd>⇧Space</kbd></button>
            <button type="button" class="tool-button" :disabled="transportDisabled || !activeClaim" :aria-pressed="looping" @click="playSelection(true)">Loop <kbd>L</kbd></button>
            <button type="button" class="tool-button" :disabled="transportDisabled" :aria-pressed="musicEnabled" @click="toggleMusic">Music {{ musicEnabled ? 'on' : 'off' }}</button>
          </section>
          <div class="time-counter" title="Playhead">
            <span class="sr-only">Playhead</span>
            <span class="time-counter-main">{{ formatTime(playhead) }}</span>
            <span class="time-counter-sub">/ {{ formatTime(endMs) }}</span>
          </div>
          <label class="review-rate"><span class="toolbar-label">Playback rate</span>
            <select aria-label="Playback rate" :value="calibrationExample ? resolvePlaybackRate(calibrationExample.claim.playbackRate) : playbackRate" :disabled="transportDisabled || !!savingDecision" @change="setPlaybackRate(Number(($event.target as HTMLSelectElement).value))">
            <option v-for="rate in SUPPORTED_PLAYBACK_RATES" :key="rate" :value="rate">{{ rate }}×</option>
            </select>
          </label>
        </template>
      </template>
      <template #toolbar-end>
        <div class="review-status" role="status" :title="statusLine">{{ statusLine }}</div>
      </template>
      <template #left>
        <div class="review-source review-rail">

          <template v-if="!remoteSource">
          <label class="review-file">Open .osu difficulties<input type="file" accept=".osu" multiple :disabled="busy || sourceLoading" @change="openFiles"></label>
          <label v-if="files.length > 1">Difficulty<select v-model="selectedFile" :disabled="busy || sourceLoading" @change="changeDifficulty"><option v-for="(file, index) in files" :key="file.name" :value="index">{{ file.name }}</option></select></label>
          <label class="review-file">Open frozen task<input type="file" accept=".json" :disabled="busy || sourceLoading" @change="importJson($event, 'task')"></label>
          <button type="button" :disabled="busy || sourceLoading" @click="chooseDirectory">{{ directoryName || 'Choose workspace folder' }}</button>
          </template>
          <template v-if="source">
            <h2>{{ source.source.title }}</h2>
            <p class="review-copy">{{ source.source.artist }} · {{ source.source.difficulty }}</p>
            <details><summary>Chart details</summary><dl class="review-facts"><dt>Beatmapset</dt><dd>{{ source.source.beatmapSetId ?? 'Local' }}</dd><dt>Difficulty</dt><dd>{{ source.source.beatmapId ?? 'Local' }}</dd><dt>Structure</dt><dd>{{ source.source.keyCount }}K · {{ source.source.noteCount }} notes</dd><dt>Source SHA</dt><dd :title="source.source.sha256">{{ source.source.sha256.slice(0, 12) }}</dd><dt>Foundation</dt><dd>{{ activeFoundation.approval.status }}</dd></dl></details>
            <details v-if="remoteSource && source.source.sha256 === remoteSource.document.source.sha256" class="review-community" aria-label="Community tags" open><summary>Community tags <span v-if="remoteSource.communityTags">· {{ remoteSource.communityTags.tags.length }}</span></summary>
              <template v-if="remoteSource.communityTags">
                <p class="review-copy">{{ remoteSource.communityTags.totalVotes.toLocaleString() }} total votes · this difficulty</p>
                <dl v-if="remoteSource.communityTags.tags.length" class="review-community-tags">
                  <template v-for="tag in remoteSource.communityTags.tags" :key="tag.id">
                    <dt>{{ tag.name }}</dt><dd :aria-label="`${tag.count} votes`">{{ tag.count.toLocaleString() }}</dd>
                  </template>
                </dl>
                <p v-else class="review-copy">No community tags recorded.</p>
                <p class="review-community-snapshot">Snapshot · {{ remoteSource.communityTags.fetchedAt.slice(0, 10) }}</p>
              </template>
              <p v-else class="review-copy">Community metadata unavailable.</p>
            </details>
            <label>Human reviewer<input v-model="humanId" autocomplete="off" placeholder="Your reviewer ID"></label>
            <template v-if="!remoteSource">
            <div class="review-actions"><button type="button" :disabled="busy || sourceLoading || !stored" @click="exportTask">Export frozen task</button><button type="button" :disabled="busy || sourceLoading || !stored" @click="exportDecisions">Export dispositions</button></div>
            <label class="review-file">Import agent handoff<input type="file" accept=".json" :disabled="busy || sourceLoading || !stored" @change="importJson($event, 'handoff')"></label>
            <label class="review-file">Import independent audit<input type="file" accept=".json" :disabled="busy || sourceLoading || !stored" @change="importJson($event, 'audit')"></label>
            <button type="button" :disabled="busy || sourceLoading || !stored" @click="reload">Reload saved workspace</button>
            </template>
          </template>
          <section v-if="document?.handoffs.length" class="review-section">
            <h2 v-if="!remoteSource">Expert review · {{ expertQueue.length }}</h2>
            <p v-if="!remoteSource" class="review-copy">{{ routineCount }} agent-reviewed · {{ agentActionCount }} awaiting agent work. Machine review is separate from human confirmation.</p>
            <p v-if="!remoteSource && !expertQueue.length" class="review-copy">No open expert cases. All submissions remain available below for inspection.</p>
            <template v-for="entry in document.handoffs" :key="entry.handoff.handoffId">
              <div v-if="!entry.handoff.proposals.length && entry.handoff.questions.length" class="review-question">
                <strong>Legacy questions · curator review</strong>
                <p v-for="question in entry.handoff.questions" :key="question.id">{{ question.text }}</p>
                <p class="review-copy">These questions have no section claim and are outside the claim review queue.</p>
              </div>
            </template>
            <div v-for="review in expertQueue.slice(0, expertLimit)" :key="`${review.handoffId}:${review.claimId}`" class="review-question">
              <strong>{{ review.claim.tagId }} · {{ review.expertReason }}</strong>
              <p>{{ review.question }}</p><p class="review-copy">{{ review.rationale }}</p>
              <button type="button" @click="openProposal(review.handoffId, review.claim)">Review {{ review.claim.tagId }} · {{ review.claim.scope.startMs }}–{{ review.claim.scope.endMs }} ms · {{ resolvePlaybackRate(review.claim.playbackRate) }}×</button>
            </div>
            <button v-if="expertQueue.length > expertLimit" type="button" @click="expertLimit += 5">Show more · {{ expertQueue.length - expertLimit }} remaining</button>
            <details class="review-all-agent-work" :open="!!remoteSource"><summary>Review history · {{ agentReviews.length }} claims</summary>
            <label>History labeler version<select v-model="chartHistoryVersion"><option value="">All versions</option><option v-for="option in chartVersions" :key="option.key" :value="option.key">{{ option.label }} · {{ option.count }}</option></select></label>
            <div v-for="entry in visibleHandoffs" :key="entry.handoff.handoffId" class="review-handoff">
              <strong>{{ entry.handoff.agent.producerId }} · {{ entry.handoff.agent.role }}</strong>
              <p class="review-copy" :title="entry.handoff.agent.skill?.sha256">{{ agentVersionLabel(entry.handoff.agent) }} · {{ new Date(entry.handoff.createdAt).toLocaleString() }}</p>
              <p class="review-copy">Task base: {{ handoffStatuses[entry.handoff.handoffId] ?? entry.baseStatus }} · {{ entry.handoff.handoffId.slice(0, 12) }}</p>
              <button v-for="claim in entry.handoff.proposals" :key="claim.id" type="button" class="review-list-row" @click="openProposal(entry.handoff.handoffId, claim)"><span>{{ claim.tagId }}<small>{{ claim.scope.startMs }}–{{ claim.scope.endMs }} ms · {{ resolvePlaybackRate(claim.playbackRate) }}×</small></span><span>{{ latestDecision(entry.handoff.handoffId, claim.id) }}</span></button>
              <details v-if="entry.handoff.audit.length"><summary>Submission self-checks · {{ entry.handoff.audit.length }}</summary><p v-for="audit in entry.handoff.audit" :key="audit.id">{{ audit.finding }}</p></details>
              <details v-if="entry.handoff.questions.length"><summary>Original questions · {{ entry.handoff.questions.length }}</summary><div v-for="question in entry.handoff.questions" :key="question.id" class="review-question"><p>{{ question.text }}</p><button v-for="claimId in question.claimIds" :key="claimId" type="button" @click="openQuestion(entry.handoff.handoffId, claimId)">Open {{ entry.handoff.proposals.find(claim => claim.id === claimId)?.tagId }}</button></div></details>
            </div>
            </details>
          </section>
          <details v-if="document?.observations.length" class="review-section"><summary>Human observations · {{ document.observations.length }}</summary><button v-for="observation in document.observations" :key="observation.id" type="button" class="review-list-row" @click="currentObservations.some(entry => entry.id === observation.id) ? openObservation(observation) : openHistoricalObservation(observation)"><span>{{ observation.claim.tagId }}<small>{{ observation.claim.scope.startMs }}–{{ observation.claim.scope.endMs }} ms · {{ resolvePlaybackRate(observation.claim.playbackRate) }}×</small><small>{{ observation.origin.kind === 'direct-human' ? 'Direct human judgment' : 'Proposal decision' }} · {{ observation.confirmedAt }} · {{ currentObservations.some(entry => entry.id === observation.id) ? 'current' : 'history' }}</small></span><span>{{ assessmentLabel(observation.claim) }}</span></button></details>

        </div>
      </template>
      <template #main>
        <div class="review-main">
          <div v-if="source && frame && !calibrationExample" class="review-preview">
          <FallingNoteViewport :annotation-bands="[]" :candidate-note-ids="candidateIds" :chart-artist="source.source.artist" :chart-difficulty="source.source.difficulty" :chart-end-ms="endMs" :chart-title="source.source.title" :frame="frame" :frame-p95-ms="0" :key-count="source.chart.keyCount" :locked="busy" :playhead-ms="playhead" :selected-note-ids="selectedNoteIds" v-bind="selectionBand ? { selectionBand } : {}" :size="size" :visual-speed="sourceVisualSpeed" @resize="size = $event" @seek="seekPlayhead" @viewport-navigate="seekPlayhead" @note-toggle="toggleNote" @range-start="beginRange($event.anchorMs)" @range-preview="dragRange($event.focusMs)" @range-commit="dragRange($event.focusMs); selectionAnchor = undefined; gestureClaim = undefined" @range-cancel="cancelRange" />
          </div>
          <div v-else-if="!calibrationExample" class="review-empty"><h2>One source. Independent judgments.</h2><p>Open a difficulty to inspect its full structure, or open a task to review agent evidence.</p></div>
          <div v-if="source && frame && !calibrationExample" class="review-timeline">
          <AnnotationTimeline :chart="source.chart" :chart-end-ms="endMs" :main-viewport-range="frame.viewportRange" :playhead-ms="playhead" :saved-annotations="[]" v-bind="activeClaim ? { selection: activeClaim.scope } : {}" :view-range="timelineRange" :disabled="busy || sourceLoading" @seek="seekPlayhead" @viewport-pan="panMainViewport" @view-range-change="timelineRange = $event" @range-start="beginRange($event.anchorMs, $event.kind)" @range-preview="dragRange($event.focusMs)" @range-commit="dragRange($event.focusMs); selectionAnchor = undefined; gestureClaim = undefined" @range-cancel="cancelRange" />
          </div>
          <section v-if="calibrationExample" class="review-calibration">
            <button type="button" @click="calibrationId = ''">Return to difficulty review</button>
            <h2>{{ calibrationExample.claim.tagId }} · {{ resolvePlaybackRate(calibrationExample.claim.playbackRate) }}× · {{ calibrationExample.source.title }} [{{ calibrationExample.source.difficulty }}]</h2>
            <p>Claim {{ calibrationExample.claim.scope.startMs }}–{{ calibrationExample.claim.scope.endMs }} source ms · Context {{ calibrationExample.claim.reviewContext.startMs }}–{{ calibrationExample.claim.reviewContext.endMs }} source ms</p>
            <p>At {{ resolvePlaybackRate(calibrationExample.claim.playbackRate) }}×: claim duration {{ playbackDurationSeconds(calibrationExample.claim.scope, calibrationExample.claim.playbackRate) }} s · context duration {{ playbackDurationSeconds(calibrationExample.claim.reviewContext, calibrationExample.claim.playbackRate) }} s. Static source evidence; playback is unavailable in this view.</p>
            <p>{{ calibrationExample.explanation }}</p>
            <div v-for="page in calibrationPages" :key="page.index" v-html="page.svg" />
          </section>
        </div>
      </template>
      <template #right>
        <div class="review-details review-rail">
        <p v-if="error" class="review-error" role="alert">{{ error }}</p>
        <p v-if="draftStorageWarning" role="alert">Browser draft storage is unavailable. Your unsaved edits remain in this page. Submit them or download a backup before refreshing or closing.
          <button type="button" @click="download('unsaved-review-drafts.json', reviewDraftStorage.unsaved())">Download unsaved drafts</button>
        </p>
        <template v-if="source">
          <template v-if="source">
            <details class="review-settings">
              <summary>Playback settings &amp; zoom</summary>
              <div class="review-playback-settings">
                <p class="review-copy">{{ audioDescription }}</p>
                <div class="review-controls">
                  <!-- Its own render scope: the playhead changes every frame while playing, and the rest of this pane does not. -->
                  <RenderScope><label>Source time · ms<input :value="Math.round(playhead)" type="number" min="0" :max="endMs" @input="seekPlayhead(($event.target as HTMLInputElement).valueAsNumber)"></label></RenderScope>
                  <label>Visual speed · px/s<input :value="speed" type="number" min="30" max="2000" step="30" @change="setVisualSpeed"></label>
                </div>
                <label>Global audio offset · ms<input :value="audioOffsetMs" type="number" step="10" :disabled="transportDisabled" @change="setAudioOffset(($event.target as HTMLInputElement).valueAsNumber)"></label>
                <div class="review-offset-actions">
                  <button type="button" :disabled="transportDisabled" @click="setAudioOffset(audioOffsetMs - 10)">−10 ms</button>
                  <button type="button" :disabled="transportDisabled" @click="setAudioOffset(audioOffsetMs + 10)">+10 ms</button>
                  <button type="button" :disabled="transportDisabled || audioOffsetMs === 0" @click="setAudioOffset(0)">Reset</button>
                </div>
                <p class="review-copy">Shared with Inspector. Positive values play audio earlier.</p>
                <AudioVolumeControl
                  :model-value="audioVolume"
                  :disabled="transportDisabled"
                  @update:model-value="setAudioVolume"
                />
                <LongNoteTailControl
                  :model-value="tailShortenMs"
                  :disabled="transportDisabled"
                  @update:model-value="setTailShortenMs"
                />
                <section class="review-zoom" aria-label="Timeline lens">
                  <button type="button" aria-label="Zoom timeline in" @click="zoomTimeline(1)" @keydown="timelineControlKeydown">Zoom in</button>
                  <button type="button" aria-label="Zoom timeline out" @click="zoomTimeline(-1)" @keydown="timelineControlKeydown">Zoom out</button>
                  <button type="button" aria-label="Fit timeline" @click="timelineRange = fitTimelineViewRange(endMs)" @keydown="timelineControlKeydown">Fit</button>
                </section>
              </div>
            </details>
          </template>
          <p v-if="savingDecision" class="review-section-complete" role="status">Saving section…</p>
          <p v-else-if="sectionComplete" class="review-section-complete" role="status">Section judgments saved together.</p>
          <p v-if="activeClaim" class="review-kicker">{{ editorOrigin === 'proposal' ? 'Agent proposal' : editorOrigin === 'observation' ? 'Saved human observation' : 'Human section draft' }} · {{ resolvePlaybackRate(activeClaim.playbackRate) }}×</p>
          <template v-if="activeClaim">
            <section v-if="!claimRateMatchesPlayback" class="review-rate-comparison" aria-label="Playback rate comparison">
              <p>Playing {{ playbackRate }}× · this judgment is for {{ resolvePlaybackRate(activeClaim.playbackRate) }}×.</p>
              <div class="review-actions"><button type="button" :disabled="busy || sourceLoading" @click="setPlaybackRate(resolvePlaybackRate(activeClaim.playbackRate))">Return to judgment rate</button><button type="button" :disabled="busy || sourceLoading || !!savingDecision" @click="createRateJudgment">Create judgment at {{ playbackRate }}×</button></div>
            </section>
            <section v-if="editorOrigin === 'proposal' && activeReview" class="review-judgment-status">
              <p class="review-kicker">{{ latestDecision(activeHandoffId, activeClaim.id) }} · <span :title="activeHandoff ? agentVersionLabel(activeHandoff.agent) : ''">{{ activeHandoff ? agentVersionLabel(activeHandoff.agent) : 'Unversioned' }}</span></p>
              <p class="review-copy" v-if="activeTrust">Source provenance · Source {{ activeTrust.source }} · Foundation {{ activeTrust.foundation }} · Human examples {{ activeTrust.humanContext }}</p>
              <p v-if="activeTrust?.foundation === 'changed'" class="review-copy">The definitions changed after this proposal. Save your judgment using the current definitions.</p>
              <p v-if="activeReview.question">{{ activeReview.question }}</p>
              <template v-if="activeReview.supersededBy"><p class="review-copy">This proposal has been replaced.</p><button type="button" @click="openQuestion(activeReview.supersededBy.handoffId, activeReview.supersededBy.claimId)">View replacement judgment</button></template>
            </section>
            <section class="review-section review-proposed-judgment">
              <header class="review-claim-heading"><h2>{{ confidenceReviewActive ? 'Selected labels · confidence review' : 'Section judgments' }}</h2><span class="review-kicker">{{ (activeClaim.scope.startMs / 1000).toFixed(3) }}–{{ (activeClaim.scope.endMs / 1000).toFixed(3) }} s</span></header>
              <a v-if="remoteSource" class="review-golden-link" :href="`/review?view=golden&tag=${encodeURIComponent(activeClaim.tagId)}`" target="_blank" rel="noopener noreferrer">Check golden set ↗<span>High-confidence references · opens a new tab</span></a>
              <WorkflowSectionSliders :claims="drafts" :tags="activeFoundation.tags" :disabled="!canEdit" :active-claim-id="activeClaimId" :confidences="confidences" :explicit-low="confidenceReviewActive" @update:claim="updateSectionAssessment" @update:confidence="updateConfidence" @select="activeClaimId = $event" />
              <p v-if="confidenceReviewActive" class="review-copy">These are the selected human labels. Choose High or Record Low for each, then save. Unchanged labels keep their existing confidence.</p>
              <p class="review-copy">Check High when confident in that label, independently of its strength. New judgments start Low; historical unrecorded confidence stays unspecified until edited.</p>
              <p v-if="drafts.some(claim => claim.assessment.presence === 'unreviewed')" class="review-copy">Unreviewed dimensions have no judgment yet.</p>
              <div class="review-actions"><button type="button" @click="focus(activeClaim.scope)">View claim range</button><button type="button" @click="focus(activeClaim.reviewContext)">View context</button></div>
            </section>
            <details class="review-section review-claim-evidence"><summary>{{ activeFoundation.tags.find(tag => tag.id === activeClaim?.tagId)?.displayName }} · evidence &amp; section range</summary>
              <WorkflowClaimEditor :model-value="activeClaim" :tags="activeFoundation.tags" :disabled="!canEdit" @update:model-value="updateEditorClaim" @focus="focus" />
              <details class="review-section"><summary>Choose source-backed evidence</summary><label>Click notes to toggle<select v-model="evidenceMode"><option value="noteRefs">Witness for this claim</option><option value="contextNoteRefs">Context notes (not negative labels)</option></select></label><button type="button" :disabled="!canEdit" @click="selectScopeNotes">Use arrangement in claim scope</button><p class="review-copy">Notes crossing the start retain their original LN start and end. Context and unselected notes are not negative labels. Select witnesses independently for each concept.</p><p class="review-copy">Selection source: {{ evidenceOriginLabel[activeEvidenceReview.selectionOrigin] }}. {{ activeEvidenceReview.operations.length ? `This draft: ${activeEvidenceReview.operations.map(evidenceOperationLabel).join("; ")}.` : "No selection operation recorded in this draft." }}</p><div class="review-note-list"><label v-for="note in visibleNotes" :key="note.id"><input type="checkbox" :checked="activeClaim.evidence[evidenceMode].some(ref => ref.sourceLine === note.sourceLine)" :disabled="!canEdit" @change="toggleNote(note.id)"><span>L{{ note.sourceLine }} · C{{ note.column + 1 }} · {{ note.startMs }}{{ note.kind === 'long' ? `–${note.endMs}` : '' }} ms</span></label></div><div class="review-actions"><button type="button" :disabled="notePage === 0" @click="notePage--">Previous notes</button><button type="button" :disabled="(notePage + 1) * 80 >= candidateNotes.length" @click="notePage++">Next notes</button></div></details>
            </details>
            <button v-if="!historicalObservation && (editorOrigin === 'direct' || editorOrigin === 'observation')" class="review-primary" type="button" :disabled="busy || !!savingDecision || sourceLoading || !stored || !approved || !humanId.trim() || draftIsStale || !claimRateMatchesPlayback" @click="saveSection">{{ editorOrigin === 'observation' ? 'Save revised section' : 'Save section judgments' }}</button>
            <section v-if="historicalObservation" class="review-historical-observation"><h2>Historical human judgment</h2><p>{{ historicalObservation.confirmedAt }} · earlier version</p><button type="button" @click="openObservation(historicalObservation)">View current judgment</button><button type="button" @click="reviseFromHistoricalObservation">Revise current judgment using this version</button></section>
            <details v-if="editorOrigin === 'observation' && observationHistory.length" class="review-observation-history"><summary>Human observation history · {{ observationHistory.length }}</summary><p v-for="entry in observationHistory" :key="entry.id">{{ assessmentLabel(entry.claim) }} · {{ confidenceLabel(entry.confidence) }} · {{ entry.confirmedAt }}<br>{{ entry.claim.scope.startMs }}–{{ entry.claim.scope.endMs }} ms · {{ resolvePlaybackRate(entry.claim.playbackRate) }}×<button type="button" @click="openHistoricalObservation(entry)">View this version</button></p></details>
            <template v-if="editorOrigin === 'proposal'">
              <section v-if="finalDecision" class="review-human-result"><h2>Human judgment · {{ finalDecision.disposition }}</h2><template v-if="finalObservation"><p>{{ finalObservation.claim.tagId }} · {{ assessmentLabel(finalObservation.claim) }} · {{ confidenceLabel(finalObservation.confidence) }}</p><button type="button" @click="openObservation(finalObservation)">View saved human judgment</button></template><p v-if="finalDecision.rationale">{{ finalDecision.rationale }}</p></section>
              <p v-if="uncertainAcceptance" class="review-copy">This historical acceptance kept {{ finalObservation?.claim.assessment.presence }}. It did not decide whether this pattern is present.</p>
              <p v-if="laterClarification" class="review-copy">Later direct human judgment: {{ assessmentLabel(laterClarification.claim) }} · {{ laterClarification.confirmedAt }}.<button type="button" @click="openObservation(laterClarification)">View human clarification</button></p>
              <p v-if="!sectionReady" class="review-copy">Assess every dimension before submitting this section. Unresolved proposals need an explicit judgment.</p>
              <div class="review-decision-controls">
                <details class="review-decision-note"><summary>Decision note (optional)</summary><label>Human decision rationale<textarea v-model="decisionNote" rows="3" placeholder="Optional, including when modifying a judgment."></textarea></label></details>
                <button type="button" :disabled="busy || !!savingDecision || sourceLoading || !approved || !humanId.trim() || !sectionReady || draftIsStale || !claimRateMatchesPlayback || !!historicalObservation" class="review-primary" @click="decideSection">Submit section review</button>
              </div>
              <details v-if="decisionsForClaim.length"><summary>Human decision history · {{ decisionsForClaim.length }}</summary><p v-for="decision in decisionsForClaim" :key="decision.id" class="review-decision">{{ decision.disposition }} · {{ decision.humanId }} · {{ decision.decidedAt }}<br>{{ decision.rationale }}<button v-if="decisionObservation(decision.observationId)" type="button" @click="openHistoricalObservation(decisionObservation(decision.observationId))">View this judgment</button></p></details>
            </template>
            <section v-if="editorOrigin === 'proposal' && activeReview" class="review-section review-audit-result">
              <details><summary>Agent reasoning &amp; provenance</summary>
              <p v-if="activeHandoff" class="review-copy" :title="activeHandoff.agent.skill?.sha256">Labeler {{ agentVersionLabel(activeHandoff.agent) }}<br>{{ new Date(activeHandoff.createdAt).toLocaleString() }} · {{ activeHandoff.agent.producerId }}</p>
              <p class="review-copy">{{ activeReview.rationale }}</p>
              <p class="review-rationale">{{ originalProposal?.evidence.rationale }}</p>
              </details>
              <details v-if="activeReview.audits.length"><summary>Independent findings · {{ activeReview.audits.length }}</summary><p v-for="finding in activeReview.audits" :key="finding.auditId" class="review-decision"><strong>{{ finding.producerId }} · {{ finding.result.outcome }}</strong><br><span :title="auditPackets.get(finding.auditId)?.agent.skill?.sha256">Auditor {{ agentVersionLabel(auditPackets.get(finding.auditId)?.agent) }}</span><br>{{ auditPackets.get(finding.auditId)?.createdAt }}<br>{{ finding.result.rationale }}</p></details>
              <details v-if="relatedReviews.length" class="review-related-history"><summary>Other judgments for this range · {{ relatedReviews.length }}</summary><p class="review-copy">Same label and overlapping ranges. These may be separate submissions; only explicit replacement links establish a revision chain.</p><button v-for="review in relatedReviews" :key="`${review.handoffId}:${review.claimId}`" type="button" @click="openQuestion(review.handoffId, review.claimId)"><span>{{ agentVersionLabel(review.agent) }}<br>{{ review.scope.startMs }}–{{ review.scope.endMs }} ms · {{ resolvePlaybackRate(review.claim.playbackRate) }}× · {{ review.status }}</span><span>View →</span></button></details>
            </section>
          </template>
          <details class="review-section" :open="!activeClaim"><summary>New section &amp; drafts</summary><div class="review-actions"><button type="button" :disabled="busy || sourceLoading" @click="newSection">New section at playhead</button><button type="button" :disabled="busy || sourceLoading" @click="restoreSection">Restore section draft</button></div></details>
          <p v-if="draftIsStale && !historicalObservation" class="review-copy">This draft was based on an earlier saved human review. Compare it with the saved observations before continuing.<button type="button" @click="editorBase = stored?.version; editorReviewRevision = document?.reviewRevision; stashDraft()">I reviewed this draft against the current revision</button></p>
          <details class="review-section"><summary>Foundation · {{ activeFoundation.tags.length }} concepts · {{ activeFoundation.calibrationExamples.length }} examples</summary>
            <p class="review-copy">Section judgments use local definitions. Community correspondences do not establish training equivalence.</p>
            <div v-for="tag in activeFoundation.tags" :key="tag.id" class="review-definition">
              <strong>{{ tag.displayName }}</strong><p>{{ tag.definition }}</p><p>Include: {{ tag.inclusionCues.join(' · ') }}</p><p>Exclude: {{ tag.exclusionCues.join(' · ') }}</p>
              <div v-for="(alignment, index) in communityAlignments(tag)" :key="index">
                <a :href="alignment.catalogueUrl" target="_blank" rel="noreferrer">{{ alignment.externalTagId }}</a>
                <p>{{ alignment.relation }} · {{ alignment.scope }}</p>
              </div>
              <p v-if="!communityAlignments(tag).length" class="review-copy">No community correspondence declared.</p>
            </div>
            <p v-if="!activeFoundation.calibrationExamples.length" class="review-copy">Initial examples are still proposed. Import a source-backed calibration Foundation before human approval.</p>
            <div v-for="example in activeFoundation.calibrationExamples" :key="example.id" class="review-definition review-calibration-example"><strong>{{ example.claim.tagId }} · {{ example.claim.exemplarRole }} · {{ resolvePlaybackRate(example.claim.playbackRate) }}×</strong><p>{{ example.source.title }} · {{ example.source.difficulty }} · {{ example.claim.scope.startMs }}–{{ example.claim.scope.endMs }} source ms</p><p>Claim duration {{ playbackDurationSeconds(example.claim.scope, example.claim.playbackRate) }} s at {{ resolvePlaybackRate(example.claim.playbackRate) }}×.</p><p>{{ example.explanation }}</p><button type="button" @click="calibrationId = example.id; mobilePanel = 'preview'">View exact source evidence</button><details><summary>Exact evidence</summary><pre>{{ serializeCanonicalJson(example.claim) }}</pre></details></div>
            <label v-if="!approved" class="review-file">Import calibration Foundation<input type="file" accept=".json" :disabled="busy || sourceLoading || !stored" @change="importJson($event, 'foundation')"></label>
            <button v-if="!approved" type="button" :disabled="busy || sourceLoading || !stored || !humanId.trim() || !activeFoundation.calibrationExamples.length" @click="approveFoundation">Approve these definitions and examples</button>
          </details>
        </template>
        </div>
      </template>
    </WorkspaceFrame>
  </main>
</template>

<style scoped>
.review-workspace { display: block; }
.review-rail { display: flex; min-width: 0; flex-direction: column; gap: 6px; padding: 8px; font-size: var(--text-sm); }
.review-rail > * { flex-shrink: 0; }
.review-rail h2 { margin: 0; font-size: var(--text-md); font-weight: 650; line-height: 1.35; }
.review-rail p { margin: 0; line-height: 1.5; }
.review-kicker { color: var(--ink-secondary); font: var(--text-xs) var(--font-data); }
.review-rationale, .review-copy, .review-decision { white-space: pre-line; }
.review-copy { color: var(--ink-secondary); font-size: var(--text-xs); line-height: 1.5; }
.review-facts { display: grid; grid-template-columns: auto 1fr; gap: 3px 8px; margin: 0; padding: 4px 0; font-size: var(--text-xs); }
.review-facts dt { color: var(--ink-muted); }
.review-community { display: grid; gap: 6px; }
.review-community-tags { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 3px 12px; margin: 2px 0; font-size: var(--text-xs); line-height: 1.5; }
.review-community-tags dt { overflow-wrap: anywhere; }
.review-community-snapshot { color: var(--ink-muted); font-size: var(--text-2xs); }
.review-rail dd { margin: 0; overflow-wrap: anywhere; font-family: var(--font-data); text-align: right; }

.review-main { display: flex; min-width: 0; min-height: 0; flex: 1 1 auto; }
.review-preview { position: relative; min-width: 0; flex: 1 1 auto; overflow: hidden; }
.review-timeline { flex: 0 0 auto; overflow: hidden; }
.review-preview > svg { height: 100%; }
.review-empty { display: grid; flex: 1 1 auto; align-content: center; gap: 8px; padding: 32px; color: var(--ink-secondary); }
.review-empty h2 { margin: 0; color: var(--ink); font-size: var(--text-lg); }
.review-calibration { display: grid; flex: 1 1 auto; align-content: start; gap: 8px; padding: 12px; overflow: auto; font-size: var(--text-sm); }
.review-calibration h2 { margin: 0; font-size: var(--text-md); }
.review-calibration p { margin: 0; color: var(--ink-secondary); }
.review-calibration > div { width: 100%; }

.review-rail button, .review-calibration > button {
  min-height: var(--control-h); padding: 3px 8px; color: var(--ink-secondary); border: 0; border-radius: var(--radius-control);
  background: var(--surface-3); box-shadow: var(--shadow-control); cursor: pointer; font-size: var(--text-xs); font-weight: 600;
  line-height: 1.3; text-align: left; transition: color 120ms var(--ease-out), background-color 120ms var(--ease-out);
}
.review-rail button:active, .review-calibration > button:active { background: var(--surface-2); }
.review-rail button:disabled { cursor: not-allowed; opacity: 0.45; }
.review-rail button.review-primary { color: oklch(100% 0 0); background: var(--signal-fill); }
.review-rail button.review-primary:disabled { color: var(--ink-secondary); background: var(--surface-3); }
@media (hover: hover) {
  .review-rail button:hover:not(:disabled), .review-calibration > button:hover { color: var(--ink); background: var(--surface-3-hover); }
  .review-rail button.review-primary:hover:not(:disabled) { background: var(--signal-fill-hover); }
}
.review-rail input, .review-rail select, .review-rail textarea, .review-rate select {
  width: 100%; min-width: 0; min-height: var(--control-h); padding: 3px 6px; color: var(--ink); border: 0; border-radius: var(--radius-control);
  background: var(--field); box-shadow: inset 0 0 0 1px var(--field-edge); font: inherit; font-size: var(--text-xs);
}
.review-rail input[type="number"] { font-family: var(--font-data); }
.review-rail input[type="file"] { padding: 2px; font-size: var(--text-2xs); }
.review-rail input[type="checkbox"], .review-rail input[type="radio"] { width: auto; min-height: 0; box-shadow: none; accent-color: var(--signal-fill); }
.review-rail textarea { padding: 6px; line-height: 1.5; }
.review-rail button:focus-visible, .review-rail summary:focus-visible, .review-rail textarea:focus-visible,
.review-rail input:focus-visible, .review-rail select:focus-visible, .review-rate select:focus-visible { outline: 2px solid var(--signal); outline-offset: 1px; }
.review-rail label { display: grid; gap: 3px; color: var(--ink-muted); font-size: var(--text-xs); }
.review-section { padding-top: 6px; border-top: 1px solid var(--seam); }
.review-rail summary { min-height: var(--header-h); padding-block: 5px; color: var(--ink-secondary); cursor: pointer; font-size: var(--text-xs); font-weight: 650; line-height: 18px; }
.review-rail details { display: block; padding: 0 8px; border-radius: var(--radius-control); background: var(--surface-2); }
.review-rail details[open] { padding-bottom: 8px; }
.review-rail details[open] > :not(summary) { margin-top: 6px; }
.review-rail details details { background: var(--surface-1); }
.review-rail details > summary::marker { color: var(--ink-muted); }
.review-claim-heading { display: flex; align-items: baseline; gap: 8px; }
.review-claim-heading h2 { min-width: 0; flex: 1; }
.review-golden-link { display: grid; align-content: center; min-height: var(--control-h); color: var(--signal); font-size: var(--text-xs); text-decoration: none; }
.review-golden-link span { color: var(--ink-muted); font-size: var(--text-2xs); }
.review-golden-link:hover { text-decoration: underline; }
.review-golden-link:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
.review-definition { padding: 6px 0; border-bottom: 1px solid var(--line); font-size: var(--text-xs); }
.review-definition p { margin-top: 4px; color: var(--ink-secondary); }
.review-definition a { color: var(--signal); }
.review-definition pre { max-height: 240px; overflow: auto; font-size: var(--text-2xs); }

.review-transport { margin: 0; padding: 0; border: 0; }
.review-transport kbd { margin-left: 2px; }
.review-rate { display: flex; flex-shrink: 0; align-items: center; gap: 5px; }
.review-rate select { width: auto; min-height: var(--control-h-sm); padding: 0 4px; font-family: var(--font-data); }
.review-status { min-width: 0; max-width: 360px; overflow: hidden; color: var(--ink-secondary); font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; }
.review-status::before { display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: var(--signal); content: ""; }
.review-rate-comparison { display: grid; gap: 6px; padding: 6px 8px; border-radius: var(--radius-control); background: var(--warning-soft); color: var(--warning); font-size: var(--text-xs); }
.review-playback-settings { display: grid; gap: 8px; }
.review-offset-actions, .review-zoom { display: flex; gap: 4px; }
.review-controls, .review-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.review-error { color: var(--danger); overflow-wrap: anywhere; }
.review-tag-navigation { display: flex; flex-shrink: 0; align-items: center; gap: 4px; }
.review-tag-navigation button { width: var(--control-h); padding: 3px; text-align: center; box-shadow: none; }
.review-tag-navigation span { color: var(--ink-secondary); font: var(--text-2xs) var(--font-data); text-align: center; }
.review-section-complete { padding-block: 6px; color: var(--success); font-size: var(--text-xs); }
.review-assessments { display: grid; gap: 1px; background: var(--seam); }
.review-assessments button { display: flex; justify-content: space-between; gap: 8px; border-radius: 0; box-shadow: none; }
.review-assessments .is-active { color: var(--ink); background: var(--signal-soft); }
.review-note-list { max-height: 300px; margin: 6px 0; overflow: auto; }
.review-note-list label { display: flex; align-items: center; gap: 8px; min-height: var(--row-h); border-bottom: 1px solid var(--line); font: var(--text-2xs) var(--font-data); }
.review-note-list input { width: 16px; min-height: 16px; }
.review-rail button.review-list-row { display: flex; justify-content: space-between; width: 100%; gap: 8px; border-radius: 0; box-shadow: none; background: transparent; border-bottom: 1px solid var(--line); }
.review-list-row small { display: block; padding-top: 2px; color: var(--ink-muted); font-size: var(--text-2xs); font-weight: 450; }
.review-question { display: grid; gap: 4px; padding: 6px 0; font-size: var(--text-xs); }
.review-proposed-judgment { display: grid; gap: 6px; padding-top: 0; border: 0; }
.review-proposed-judgment h2 { font-size: var(--text-md); }
.review-human-result { display: grid; gap: 6px; padding-block: 6px; border-block: 1px solid var(--line); }
.review-judgment-status, .review-audit-result { display: grid; gap: 6px; }
.review-decision-note summary { color: var(--ink-secondary); }
.review-decision { padding: 6px 0; border-top: 1px solid var(--line); font-size: var(--text-xs); }
</style>
