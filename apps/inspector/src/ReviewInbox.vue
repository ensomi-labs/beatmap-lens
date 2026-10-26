<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { resolvePlaybackRate } from "./annotation/playback-rate";
import { type ConfidenceReviewPlan, confidenceReviewRows } from "./annotation/workflow/confidence-review";
import { type InboxClaimV2, type InboxSourceV2, type RemoteSourceV2, type ReviewInboxV2, reviewRequest } from "./annotation/workflow/remote-workspace";
import { agentVersionLabel, auditVersionLabel, matchesReviewVersions, reviewVersionOptions } from "./annotation/workflow/review-provenance";
import { assessmentStrength, drawReviewSample, REVIEW_TARGETS, type ReviewSampleBatch, type ReviewSampleItem, type SampleStrength, sampleCandidates, sampleKey, sampleRef } from "./annotation/workflow/review-sampling";
import GoldenSetBrowser from "./GoldenSetBrowser.vue";
import ReviewWorkspace from "./ReviewWorkspace.vue";

const inbox = shallowRef<ReviewInboxV2>();
const connectionError = ref("");
const loadError = ref("");
const activeSource = shallowRef<RemoteSourceV2>();
const openClaim = shallowRef<{ handoffId: string; claimId: string }>();
const openHumanObservationIds = shallowRef<readonly string[]>();
const confidencePlan = shallowRef<ConfidenceReviewPlan>();
const confidencePlanError = ref("");
const confidencePlanUrl = new URLSearchParams(window.location.search).get("confidencePlan");
const goldenSetRequested = new URLSearchParams(window.location.search).get("view") === "golden";
const activeConfidenceId = ref("");
const confidenceRows = computed(() => confidencePlan.value ? confidenceReviewRows(confidencePlan.value, inbox.value?.sources ?? []) : []);
const confidenceCompleted = computed(() => confidenceRows.value.reduce((sum, row) => sum + row.completed, 0));
const confidenceTotal = computed(() => confidenceRows.value.reduce((sum, row) => sum + row.item.observationIds.length, 0));
const nextConfidence = computed(() => {
  const rows = confidenceRows.value;
  const current = rows.findIndex(row => row.item.id === activeConfidenceId.value);
  return [...rows.slice(current + 1), ...rows.slice(0, Math.max(current, 0))].find(row => row.available && !row.complete);
});
const showingInbox = ref(true);
const loading = ref(false);
const recentSources = new Map<string, RemoteSourceV2>();
const sourceLoads = new Map<string, Promise<RemoteSourceV2>>();
const lastSynced = ref("");
const inboxView = ref<"requests" | "sample" | "history" | "confidence" | "golden">(goldenSetRequested ? "golden" : confidencePlanUrl ? "confidence" : "requests");
const showingProvenance = ref(false);
const labelerVersion = ref("");
const auditorVersion = ref("");
const historySearch = ref("");
const historyStatus = ref("");
const historyTag = ref("");
const historyLimit = ref(50);
const versions = computed(() => ({ labelerVersion: labelerVersion.value, auditorVersion: auditorVersion.value }));
const allReviews = computed(() => (inbox.value?.sources ?? []).flatMap(source => source.reviews));
const labelerVersions = computed(() => reviewVersionOptions(allReviews.value, "labeler"));
const auditorVersions = computed(() => reviewVersionOptions(allReviews.value, "auditor"));
const versionedItems = computed(() => (inbox.value?.sources ?? []).flatMap(source => source.reviews
  .filter(claim => matchesReviewVersions(claim, versions.value)).map(claim => ({ source, claim }))));
const historyStatuses = computed(() => [...new Set(versionedItems.value.map(item => item.claim.status))].sort());
const historyItems = computed(() => {
  const terms = historySearch.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return versionedItems.value.filter(({ source, claim }) => (!historyStatus.value || claim.status === historyStatus.value)
    && (!historyTag.value || claim.tagId === historyTag.value)
    && terms.every(term => [source.source.title, source.source.difficulty, claim.handoffId, claim.agent?.producerId,
      ...(claim.audits ?? []).map(audit => audit.agent.producerId)].join(" ").toLowerCase().includes(term)))
    .sort((a, b) => (b.claim.submittedAt ?? "").localeCompare(a.claim.submittedAt ?? "") || sampleKey(sampleRef(a)).localeCompare(sampleKey(sampleRef(b))));
});
const historySources = computed(() => {
  const terms = historySearch.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return (inbox.value?.sources ?? []).filter(source => terms.every(term => [source.source.title, source.source.difficulty].join(" ").toLowerCase().includes(term)));
});
watch([labelerVersion, auditorVersion, historySearch, historyStatus, historyTag], () => { historyLimit.value = 50; });
const sampleTag = ref("");
const sampleStrength = ref<SampleStrength>("all");
const sampleLimit = ref(10);
const sampleBatch = shallowRef<ReviewSampleBatch>();
const activeSampleKey = ref("");
const candidates = computed(() => sampleCandidates(inbox.value?.sources ?? [], sampleTag.value, sampleStrength.value, versions.value));
const sampleItems = computed(() => new Map((inbox.value?.sources ?? []).flatMap(source => source.reviews.map(claim => {
  const item = { source, claim };
  return [sampleKey(sampleRef(item)), item] as const;
}))));
const sampleRows = computed(() => (sampleBatch.value?.claims ?? []).map(reference => ({
  key: sampleKey(reference), item: sampleItems.value.get(sampleKey(reference)),
})));
const sampleReviewed = computed(() => sampleRows.value.filter(row => row.item && ["accepted", "modified", "rejected"].includes(row.item.claim.status)).length);
const remainingSample = computed(() => sampleRows.value.find(row => row.item && !["accepted", "modified", "rejected", "deferred", "superseded"].includes(row.item.claim.status))?.item);
const nextSample = computed(() => {
  const rows = sampleRows.value;
  const current = rows.findIndex(row => row.key === activeSampleKey.value);
  return [...rows.slice(current + 1), ...rows.slice(0, current)].find(row => row.item && !["accepted", "modified", "rejected", "deferred", "superseded"].includes(row.item.claim.status))?.item;
});
watch(() => !showingInbox.value ? nextSample.value?.source : undefined, next => {
  if (next && next.source.sha256 !== activeSource.value?.document.source.sha256)
    void loadSource(next).catch(() => {}); // Prefetch failure is retried by an explicit open.
});

function syncTrust(current: RemoteSourceV2, summary: InboxSourceV2): RemoteSourceV2 {
  const trust = { ...current.handoffTrust, ...Object.fromEntries(summary.reviews.flatMap(claim => claim.trust ? [[claim.handoffId, claim.trust]] : [])) };
  return JSON.stringify(trust) === JSON.stringify(current.handoffTrust ?? {}) ? current : { ...current, handoffTrust: trust };
}

async function loadSource(source: InboxSourceV2): Promise<RemoteSourceV2> {
  const sha = source.source.sha256;
  const cached = recentSources.get(sha);
  if (cached?.version.sha256 === source.version.sha256) {
    recentSources.delete(sha);
    const current = syncTrust(cached, source);
    recentSources.set(sha, current);
    return current;
  }
  const key = `${sha}:${source.version.sha256}`;
  const pending = sourceLoads.get(key);
  if (pending) return pending;
  const request = reviewRequest<RemoteSourceV2>(`source/${sha}`).then(loaded => {
    recentSources.delete(sha);
    recentSources.set(sha, loaded);
    for (const oldest of recentSources.keys()) {
      if (recentSources.size <= 3) break;
      recentSources.delete(oldest);
    }
    return loaded;
  }).finally(() => sourceLoads.delete(key));
  sourceLoads.set(key, request);
  return request;
}
const sampleStorageKey = computed(() => `beatmap-lens-review-sample:${inbox.value?.workspace}`);
watch(() => inbox.value?.workspace, workspace => {
  if (!workspace) return;
  const saved = localStorage.getItem(sampleStorageKey.value);
  sampleBatch.value = saved ? JSON.parse(saved) : undefined;
  if (sampleBatch.value && !confidencePlanUrl && !goldenSetRequested) {
    sampleTag.value = sampleBatch.value.tagId;
    sampleStrength.value = sampleBatch.value.strength;
    labelerVersion.value = sampleBatch.value.labelerVersion ?? "";
    auditorVersion.value = sampleBatch.value.auditorVersion ?? "";
    inboxView.value = "sample";
  }
});
let timer: ReturnType<typeof setTimeout>;
let stopped = false;
let refreshing = false;
let selection = 0;
const tasks = computed(() => (inbox.value?.sources ?? []).flatMap(source => [
  ...(source.requests ?? []).filter(request => request.pendingClaimIds.length).map(request => ({
    id: request.requestId, source, title: "Review spot-check", question: request.question,
    claims: source.reviews.filter(review => request.handoffId === review.handoffId && request.pendingClaimIds.includes(review.claimId)),
  })),
  ...source.expertQueue.filter(review => !(source.requests ?? []).some(request => request.handoffId === review.handoffId && request.pendingClaimIds.includes(review.claimId))).map(review => ({
    id: `${review.handoffId}:${review.claimId}`, source, title: "Expert judgment needed", question: review.question ?? review.rationale, claims: [review],
  })),
]).map(task => ({ ...task, claims: task.claims.filter(claim => matchesReviewVersions(claim, versions.value)) })).filter(task => task.claims.length));
const counts = computed(() => {
  const total: Record<string, number> = {};
  for (const source of inbox.value?.sources ?? []) for (const [status, count] of Object.entries(source.counts)) total[status] = (total[status] ?? 0) + count;
  return total;
});
const failedDeliveries = computed(() => inbox.value?.receipts.filter(receipt => receipt.status === "error") ?? []);
const humanAssessments = computed(() => (inbox.value?.sources ?? []).reduce((total, source) => ({
  settled: total.settled + (source.humanAssessmentCounts?.settled ?? 0),
  unresolved: total.unresolved + (source.humanAssessmentCounts?.unresolved ?? 0),
  unreviewed: total.unreviewed + (source.humanAssessmentCounts?.unreviewed ?? 0),
}), { settled: 0, unresolved: 0, unreviewed: 0 }));

function reviewLabel(claim: InboxClaimV2): string {
  if (!claim.assessment || !["accepted", "modified"].includes(claim.status)) return claim.status;
  return `${claim.status} · ${claim.assessment.presence}${claim.assessment.presence === "present" ? ` · ${claim.assessment.salience}` : ""}`;
}

function trustLabel(claim: InboxClaimV2): string {
  if (!claim.trust) return "Evidence context untracked";
  return `Source ${claim.trust.source} · Foundation ${claim.trust.foundation} · human examples ${claim.trust.humanContext}`;
}

function strengthLabel(claim: InboxClaimV2): string {
  const strength = assessmentStrength(claim);
  return strength === "absent" ? "absent · 0" : strength;
}

function versionSelectionLabel(value: string | undefined, role: "labeler" | "auditor"): string {
  if (!value) return "All versions";
  return (role === "labeler" ? labelerVersions.value : auditorVersions.value).find(option => option.key === value)?.label
    ?? (/^[a-f0-9]{64}$/.test(value) ? `Saved content ${value.slice(0, 8)} · all matching versions` : "Saved version · unavailable");
}

function submittedLabel(claim: InboxClaimV2): string {
  return claim.submittedAt ? new Date(claim.submittedAt).toLocaleString() : "Submission time unavailable";
}

function drawSample(): void {
  sampleBatch.value = {
    createdAt: new Date().toISOString(), tagId: sampleTag.value, strength: sampleStrength.value,
    ...versions.value,
    claims: drawReviewSample(candidates.value, sampleLimit.value),
  };
  activeSampleKey.value = "";
  localStorage.setItem(sampleStorageKey.value, JSON.stringify(sampleBatch.value));
}

function openSample(item: ReviewSampleItem): Promise<void> {
  return open(item.source, item.claim, sampleKey(sampleRef(item)));
}

async function refresh(): Promise<void> {
  if (refreshing || stopped) return;
  refreshing = true;
  try {
    const next = await reviewRequest<ReviewInboxV2>("inbox");
    if (stopped) return;
    if (!inbox.value && !confidencePlanUrl && !goldenSetRequested && !next.sources.some(source => source.expertQueue.length || source.requests?.some(request => request.pendingClaimIds.length))) inboxView.value = "history";
    inbox.value = next;
    connectionError.value = "";
    lastSynced.value = new Date().toLocaleTimeString();
    const current = activeSource.value;
    const summary = next.sources.find(source => source.source.sha256 === current?.document.source.sha256);
    if (current && summary && summary.version.revision > current.version.revision) {
      const source = await reviewRequest<RemoteSourceV2>(`source/${summary.source.sha256}`);
      if (activeSource.value?.document.source.sha256 === source.document.source.sha256 && source.version.revision > activeSource.value.version.revision) activeSource.value = source;
    } else if (current && summary) {
      const synced = syncTrust(current, summary);
      if (synced !== current) { activeSource.value = synced; recentSources.set(summary.source.sha256, synced); }
    }
  } catch (error) {
    connectionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    refreshing = false;
  }
}

async function poll(): Promise<void> {
  await refresh();
  if (!stopped) timer = setTimeout(poll, 1200);
}

async function open(source: InboxSourceV2, claim?: InboxClaimV2, sample = ""): Promise<void> {
  const request = ++selection;
  loading.value = true;
  loadError.value = "";
  try {
    if (activeSource.value?.document.source.sha256 !== source.source.sha256) {
      const loaded = await loadSource(source);
      if (request !== selection) return;
      activeSource.value = loaded;
    }
    openClaim.value = claim ? { handoffId: claim.handoffId, claimId: claim.claimId } : undefined;
    openHumanObservationIds.value = undefined;
    activeConfidenceId.value = "";
    activeSampleKey.value = sample;
    showingInbox.value = false;
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (request === selection) loading.value = false;
  }
}

async function loadConfidencePlan(): Promise<void> {
  if (!confidencePlanUrl) return;
  try {
    const url = new URL(confidencePlanUrl, window.location.href);
    if (url.origin !== window.location.origin) throw new Error("Confidence plans must use this review service.");
    const response = await fetch(url.pathname + url.search, { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not load confidence plan (${response.status}).`);
    const plan = await response.json() as ConfidenceReviewPlan;
    if (plan.version !== 1 || !Array.isArray(plan.items) || !plan.items.length)
      throw new Error("The confidence plan must contain selected human observations.");
    confidencePlan.value = plan;
  } catch (cause) {
    confidencePlanError.value = cause instanceof Error ? cause.message : String(cause);
  }
}

async function openConfidence(row: typeof confidenceRows.value[number]): Promise<void> {
  if (!row.available || !row.source) return;
  await open(row.source);
  if (loadError.value || activeSource.value?.document.source.sha256 !== row.item.sourceSha256) return;
  activeConfidenceId.value = row.item.id;
  openHumanObservationIds.value = row.targets.flatMap(target => target ? [target.id] : []);
}

onMounted(() => { void poll(); void loadConfidencePlan(); });
onBeforeUnmount(() => { stopped = true; clearTimeout(timer); });
</script>

<template>
  <div v-show="showingInbox" class="inbox-page" :class="{ 'inbox-page--golden': inboxView === 'golden' }">
    <header class="inbox-header"><div><p class="inbox-kicker">Beatmap Lens</p><h1>{{ inboxView === 'golden' ? 'Golden set' : 'Review inbox' }}</h1></div><p class="inbox-connection" role="status">{{ connectionError ? 'Connection interrupted · last inbox retained' : inbox ? `Connected · ${lastSynced}` : 'Connecting…' }}</p></header>
    <p v-if="connectionError" class="inbox-error" role="alert">{{ connectionError }}</p>
    <p v-if="loadError" class="inbox-error" role="alert">{{ loadError }}</p>
    <nav class="inbox-view-switch" aria-label="Review inbox views">
      <button type="button" :aria-pressed="inboxView === 'requests'" @click="inboxView = 'requests'">Requests <span>{{ tasks.length }}</span></button>
      <button type="button" :aria-pressed="inboxView === 'sample'" aria-label="Sample machine-reviewed sections" @click="inboxView = 'sample'">Sample <span v-if="sampleBatch">{{ sampleReviewed }}/{{ sampleRows.length }}</span></button>
      <button type="button" :aria-pressed="inboxView === 'history'" aria-label="Browse review history" @click="inboxView = 'history'">History <span>{{ allReviews.length }}</span></button>
      <button type="button" :aria-pressed="inboxView === 'golden'" @click="inboxView = 'golden'">Golden set</button>
      <button v-if="confidencePlanUrl" type="button" :aria-pressed="inboxView === 'confidence'" @click="inboxView = 'confidence'">Confidence <span>{{ confidenceCompleted }}/{{ confidenceTotal }}</span></button>
    </nav>
    <GoldenSetBrowser v-if="showingInbox && inboxView === 'golden'" />
    <section v-if="inboxView !== 'confidence' && inboxView !== 'golden'" class="inbox-version-filters" aria-label="Review version filters">
      <div class="inbox-filter-controls">
        <label>Labeler version<select v-model="labelerVersion" name="labelerVersion"><option value="">All versions · {{ labelerVersions.length }}</option><option v-if="labelerVersion && !labelerVersions.some(option => option.key === labelerVersion)" :value="labelerVersion">{{ versionSelectionLabel(labelerVersion, 'labeler') }}</option><option v-for="option in labelerVersions" :key="option.key" :value="option.key">{{ option.label }} · {{ option.count }} claims</option></select></label>
        <label>Auditor version<select v-model="auditorVersion" name="auditorVersion"><option value="">All versions · {{ auditorVersions.length }}</option><option v-if="auditorVersion && !auditorVersions.some(option => option.key === auditorVersion)" :value="auditorVersion">{{ versionSelectionLabel(auditorVersion, 'auditor') }}</option><option v-for="option in auditorVersions" :key="option.key" :value="option.key">{{ option.label }} · {{ option.count }} claims</option></select></label>
      </div>
      <div class="inbox-filter-summary"><span>{{ versionedItems.length }} / {{ allReviews.length }} claims · all views use these versions</span><button v-if="labelerVersion || auditorVersion" type="button" @click="labelerVersion = ''; auditorVersion = ''">Clear versions</button></div>
      <p v-if="auditorVersion">Shows claims reviewed by this auditor version. Their status still reflects all recorded audits and human decisions.</p>
    </section>
    <section v-if="inboxView === 'confidence'" class="inbox-sampler confidence-review-queue">
      <h2>{{ confidencePlan?.title ?? 'Loading confidence review…' }}</h2>
      <p v-if="confidencePlanError" role="alert">{{ confidencePlanError }}</p>
      <template v-if="confidencePlan">
        <p role="status">{{ confidenceCompleted }}/{{ confidenceTotal }} labels have confidence · {{ confidenceRows.length }} selected sections</p>
        <p>Review each selected label and explicitly choose High or Low, then save the section. Progress follows the saved human judgment.</p>
        <button v-if="nextConfidence" type="button" class="inbox-continue" :disabled="loading" @click="openConfidence(nextConfidence)">Continue confidence review →</button>
        <div class="inbox-sample-list"><button v-for="(row, index) in confidenceRows" :key="row.item.id" type="button" :disabled="loading || !row.available" @click="openConfidence(row)">
          <span>{{ index + 1 }}. {{ row.source?.source.title ?? 'Source unavailable' }}<small>{{ row.source?.source.difficulty }}<template v-if="row.targets[0]"> · {{ (row.targets[0].scope.startMs / 1000).toFixed(3) }}–{{ (row.targets[0].scope.endMs / 1000).toFixed(3) }} s · {{ row.targets[0].playbackRate }}×</template></small><small>{{ row.targets.map(target => target ? `${REVIEW_TARGETS[target.tagId] ?? target.tagId}: ${target.assessment.presence === 'present' ? target.assessment.salience : target.assessment.presence}` : 'Judgment unavailable').join(' · ') }}</small></span>
          <span>{{ row.available ? `${row.completed}/${row.item.observationIds.length} labels · ${row.complete ? 'Saved' : 'Review →'}` : 'Current human judgment unavailable' }}</span>
        </button></div>
      </template>
    </section>
    <section v-if="inboxView === 'sample'" id="review-sampler" class="inbox-sampler">
      <h2>{{ sampleBatch ? 'Review your sample' : 'Sample section labels' }}</h2>
      <button v-if="remainingSample" type="button" class="inbox-continue" :disabled="loading" @click="openSample(remainingSample)">Continue review <span>{{ sampleReviewed }}/{{ sampleRows.length }} reviewed →</span></button>
      <details :open="!sampleBatch" class="inbox-sample-setup"><summary>{{ sampleBatch ? 'Draw a new sample' : 'Sample settings' }}</summary>
      <details class="inbox-help"><summary>How sampling works</summary><p>Random section labels. Identical judgments within the same labeler and auditor versions are sampled once; human-reviewed and superseded claims are excluded. Work status and source provenance remain visible; changed human examples do not block review. Modify to save a replacement judgment; reject when no replacement is available.</p></details>
      <form class="inbox-sample-controls" @submit.prevent="drawSample">
        <label>Label type<select v-model="sampleTag" name="sampleTag"><option value="">All five labels</option><option v-for="(name, id) in REVIEW_TARGETS" :key="id" :value="id">{{ name }}</option></select></label>
        <label>Strength<select v-model="sampleStrength" name="sampleStrength"><option value="all">All strengths</option><option value="absent">Absent · 0</option><option value="supporting">Supporting · weak</option><option value="prominent">Prominent · strong</option></select></label>
        <label>Sample count<input v-model.number="sampleLimit" type="number" min="1" max="100" step="1" required></label>
        <button type="submit" class="inbox-sample-draw" :disabled="!candidates.length || !!connectionError || loading">{{ sampleBatch ? 'Draw new sample' : 'Draw sample' }}</button>
      </form>
      <p class="inbox-sample-count" role="status">{{ candidates.length }} matching sections · up to {{ sampleLimit }} will be drawn</p>
      </details>
      <template v-if="sampleBatch">
        <div class="inbox-sample-heading"><h2>Current sample · {{ sampleReviewed }}/{{ sampleRows.length }} reviewed</h2><span>{{ REVIEW_TARGETS[sampleBatch.tagId] ?? 'All labels' }} · {{ sampleBatch.strength }} · saved in this browser</span></div>
        <p>Sample versions: labeler {{ versionSelectionLabel(sampleBatch.labelerVersion, 'labeler') }} · auditor {{ versionSelectionLabel(sampleBatch.auditorVersion, 'auditor') }}. Changing filters affects the next draw.</p>

        <div class="inbox-sample-list"><template v-for="(row, index) in sampleRows" :key="row.key">
          <button v-if="row.item" type="button" :disabled="loading" @click="openSample(row.item)">
            <span><span class="inbox-sample-number">{{ index + 1 }}.</span> {{ row.item.source.source.title }} <small>[{{ row.item.source.source.difficulty }}] · {{ (row.item.claim.scope.startMs / 1000).toFixed(3) }}–{{ (row.item.claim.scope.endMs / 1000).toFixed(3) }} s · {{ resolvePlaybackRate(row.item.claim.playbackRate) }}×</small><small :title="agentVersionLabel(row.item.claim.agent)">Version {{ agentVersionLabel(row.item.claim.agent) }}</small></span>
            <span>{{ REVIEW_TARGETS[row.item.claim.tagId] ?? row.item.claim.tagId }} · {{ strengthLabel(row.item.claim) }}<small>{{ reviewLabel(row.item.claim) }} →</small><small>{{ trustLabel(row.item.claim) }}</small></span>
          </button>
          <p v-else>Sample {{ index + 1 }} is no longer available in this workspace.</p>
        </template></div>
      </template>
    </section>
    <section v-if="inboxView === 'history'" id="review-history" class="inbox-history">
      <div class="inbox-section-heading"><h2>Review history</h2><button type="button" :aria-pressed="showingProvenance" @click="showingProvenance = !showingProvenance">{{ showingProvenance ? 'Hide provenance' : 'Show provenance' }}</button></div>
      <div class="inbox-filter-controls inbox-history-controls">
        <label>Search history<input v-model="historySearch" type="search" name="historySearch" placeholder="Chart, difficulty or agent"></label>
        <label>Review status<select v-model="historyStatus" name="historyStatus"><option value="">All statuses</option><option v-for="state in historyStatuses" :key="state" :value="state">{{ state }}</option></select></label>
        <label>History label<select v-model="historyTag" name="historyTag"><option value="">All five labels</option><option v-for="(name, id) in REVIEW_TARGETS" :key="id" :value="id">{{ name }}</option></select></label>
      </div>
      <p role="status">{{ historyItems.length }} matching records · newest first · showing {{ Math.min(historyLimit, historyItems.length) }}</p>
      <div class="inbox-history-list"><button v-for="item in historyItems.slice(0, historyLimit)" :key="sampleKey(sampleRef(item))" type="button" :disabled="loading" @click="open(item.source, item.claim)">
        <span>{{ item.source.source.title }} <small>[{{ item.source.source.difficulty }}] · <span :title="agentVersionLabel(item.claim.agent)">version {{ agentVersionLabel(item.claim.agent) }}</span></small><small v-if="showingProvenance">{{ submittedLabel(item.claim) }}<br>Labeler {{ agentVersionLabel(item.claim.agent) }}<br>Auditor {{ auditVersionLabel(item.claim) }}</small></span>
        <span>{{ REVIEW_TARGETS[item.claim.tagId] ?? item.claim.tagId }} · {{ strengthLabel(item.claim) }}<small>{{ (item.claim.scope.startMs / 1000).toFixed(3) }}–{{ (item.claim.scope.endMs / 1000).toFixed(3) }} s · {{ resolvePlaybackRate(item.claim.playbackRate) }}× · {{ reviewLabel(item.claim) }} →</small><small>{{ trustLabel(item.claim) }}</small></span>
      </button></div>
      <details class="inbox-chart-history"><summary>Charts and human judgments · {{ historySources.length }}</summary><p>Open a chart to inspect or revise saved human judgments, including charts without agent proposals.</p><div class="inbox-history-list"><button v-for="source in historySources.slice(0, historyLimit)" :key="source.source.sha256" type="button" :disabled="loading" @click="open(source)"><span>{{ source.source.title }}<small>{{ source.source.difficulty }}</small></span><span>Open chart →</span></button></div><button v-if="historySources.length > historyLimit" type="button" @click="historyLimit += 50">Show 50 more charts</button></details>
      <p v-if="!historyItems.length">No review history matches these filters.</p>
      <button v-if="historyItems.length > historyLimit" type="button" @click="historyLimit += 50">Show 50 more records</button>
    </section>
    <template v-if="inboxView === 'requests'">
    <section v-if="inbox && !tasks.length" class="inbox-empty"><h2>No requests waiting{{ labelerVersion || auditorVersion ? ' for these versions' : '' }}</h2><p>New requests arrive here automatically. Browse review history to inspect earlier results.</p></section>
    <section v-for="task in tasks" :key="`${task.source.source.sha256}:${task.id}`" class="inbox-task">
      <div><p class="inbox-kicker">{{ task.title }}</p><h2>{{ task.source.source.title }} <span>[{{ task.source.source.difficulty }}]</span></h2><p class="inbox-question">{{ task.question }}</p></div>
      <div class="inbox-claims"><button v-for="claim in task.claims" :key="claim.claimId" type="button" :disabled="loading" @click="open(task.source, claim)"><span>{{ claim.tagId }}<small>{{ (claim.scope.startMs / 1000).toFixed(3) }}–{{ (claim.scope.endMs / 1000).toFixed(3) }} s · {{ resolvePlaybackRate(claim.playbackRate) }}× · {{ claim.status }}</small><small :title="agentVersionLabel(claim.agent)">Version {{ agentVersionLabel(claim.agent) }}</small></span><span>Review →</span></button></div>
    </section>
    </template>
    <details v-if="failedDeliveries.length" class="inbox-history"><summary>Delivery issues · {{ failedDeliveries.length }}</summary><p v-for="receipt in failedDeliveries" :key="receipt.id">{{ receipt.error }}</p></details>
    <footer v-if="inbox"><details><summary>Workspace details &amp; help</summary><div class="inbox-summary"><span>{{ counts['agent-reviewed'] ?? 0 }} machine-reviewed</span><span>{{ humanAssessments.settled }} explicit human judgments</span><span>{{ humanAssessments.unresolved + humanAssessments.unreviewed }} uncertain or unreviewed human records</span><span>{{ counts.deferred ?? 0 }} deferred</span></div><p>Version filters apply to requests, sampling and history. Skill names, revisions and content hashes identify separate versions. Evidence context is shown separately from work status and agent version.</p><p>History includes human decisions, stale results and superseded proposals. Open a result to inspect its audits and related versions.</p><p>Decisions are saved to the connected workspace and returned to the agent automatically.</p></details></footer>
  </div>
  <div v-if="activeSource" v-show="!showingInbox" class="inbox-active">
    <p v-if="loadError" class="inbox-active-error" role="alert">{{ loadError }}</p>
    <ReviewWorkspace :active="!showingInbox" :remote-source="activeSource" v-bind="{ ...(openClaim ? { openClaim } : {}), ...(openHumanObservationIds ? { openHumanObservationIds } : {}) }" @back-to-inbox="showingInbox = true" @saved="refresh" >
      <template #navigation>
        <div class="inbox-navigation"><button type="button" class="tool-button" @click="showingInbox = true">{{ activeConfidenceId ? `Confidence · ${confidenceCompleted}/${confidenceTotal}` : activeSampleKey ? `Sample · ${sampleReviewed}/${sampleRows.length}` : `Inbox · ${tasks.length}` }}{{ connectionError ? ' · offline' : '' }}</button><button v-if="activeConfidenceId && nextConfidence" type="button" class="tool-button" :disabled="loading" @click="openConfidence(nextConfidence)">Next confidence section →</button><button v-if="activeSampleKey && nextSample" type="button" class="tool-button" :disabled="loading" @click="openSample(nextSample)">Next sample →</button></div>
      </template>
    </ReviewWorkspace>
  </div>
</template>

<style scoped>
.inbox-page { max-width: 1100px; margin: 0 auto; padding: 24px 24px 40px; color: var(--ink); font-size: var(--text-sm); }
.inbox-page--golden { max-width: 1500px; }
.inbox-header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; }
.inbox-page h1 { margin: 4px 0 8px; font-size: 20px; font-weight: 650; letter-spacing: -0.015em; }
.inbox-page h2 { margin: 4px 0 8px; font-size: var(--text-md); font-weight: 650; }
.inbox-page p { margin: 0; line-height: 1.55; }
.inbox-kicker, .inbox-connection { color: var(--ink-muted); font: var(--text-xs) var(--font-data); }
.inbox-connection { padding-top: 6px; white-space: nowrap; }
.inbox-summary { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 8px; padding: 8px 0; border-block: 1px solid var(--line); font-size: var(--text-xs); }
.inbox-summary span { color: var(--ink-secondary); }
.inbox-empty { padding: 32px 0; }
.inbox-empty p, .inbox-page footer { color: var(--ink-secondary); font-size: var(--text-xs); }
.inbox-task { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; padding: 16px 0; border-bottom: 1px solid var(--line); }
.inbox-question { font-size: var(--text-sm); white-space: pre-line; }
.inbox-page button {
  display: flex; width: 100%; min-height: 30px; align-items: center; justify-content: space-between; gap: 12px; padding: 5px 10px;
  color: var(--ink-secondary); border: 0; border-radius: var(--radius-control); background: var(--surface-3); box-shadow: var(--shadow-control);
  cursor: pointer; font-size: var(--text-xs); font-weight: 600; text-align: left; transition: color 120ms var(--ease-out), background-color 120ms var(--ease-out);
}
.inbox-page button:active { background: var(--surface-2); }
.inbox-page button:focus-visible, .inbox-page input:focus-visible, .inbox-page select:focus-visible, .inbox-page summary:focus-visible { outline: 2px solid var(--signal); outline-offset: 1px; }
@media (hover: hover) { .inbox-page button:hover:not(:disabled) { color: var(--ink); background: var(--surface-3-hover); } }
.inbox-page button:disabled { cursor: not-allowed; opacity: 0.5; }
.inbox-page button small { display: block; margin-top: 3px; color: var(--ink-muted); font: var(--text-2xs) var(--font-data); }
.inbox-claims { display: grid; align-content: start; gap: 4px; }
.inbox-history { padding: 12px 0; }
.inbox-page summary { min-height: var(--header-h); color: var(--ink-secondary); cursor: pointer; font-size: var(--text-xs); font-weight: 650; line-height: var(--header-h); }
.inbox-history section { margin-top: 12px; }
.inbox-page .inbox-history-list button { border-bottom: 1px solid var(--line); border-radius: 0; background: transparent; box-shadow: none; }
.inbox-history p { color: var(--ink-secondary); font-size: var(--text-xs); }
.inbox-page footer { padding-top: 16px; }
.inbox-error { margin-top: 8px; color: var(--danger); }
.inbox-navigation { display: flex; gap: 4px; }
.inbox-active-error {
  position: fixed; z-index: 40; top: 46px; left: 50%; max-width: 420px; padding: 6px 10px; color: oklch(88% 0.06 25); border-radius: var(--radius-control);
  background: var(--danger-soft); box-shadow: inset 0 0 0 1px oklch(72% 0.17 25 / 0.4); font-size: var(--text-xs); transform: translateX(-50%);
}
.inbox-sampler > p, .inbox-sample-heading > span { color: var(--ink-secondary); font-size: var(--text-xs); }
.inbox-sampler { padding: 12px 0 16px; border-bottom: 1px solid var(--line); }
.inbox-sample-controls { display: grid; grid-template-columns: 1.3fr 1.3fr 0.7fr auto; align-items: end; gap: 8px; margin: 12px 0 6px; }
.inbox-sample-controls label, .inbox-filter-controls label { display: grid; min-width: 0; gap: 3px; color: var(--ink-muted); font-size: var(--text-xs); }
.inbox-filter-controls { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 12px 0 8px; }
.inbox-filter-controls select, .inbox-filter-controls input, .inbox-sample-controls select, .inbox-sample-controls input {
  width: 100%; min-width: 0; min-height: var(--control-h); padding: 3px 6px; color: var(--ink); border: 0; border-radius: var(--radius-control);
  background: var(--field); box-shadow: inset 0 0 0 1px var(--field-edge); font: inherit; font-size: var(--text-xs);
}
.inbox-version-filters p { color: var(--ink-secondary); font-size: var(--text-xs); }
.inbox-history-controls { grid-template-columns: 2fr 1fr 1fr; }
.inbox-history-list { margin: 8px 0; }
.inbox-history-list button > span { min-width: 0; overflow-wrap: anywhere; }
.inbox-history-list button > span:last-child { text-align: right; }
.inbox-page .inbox-sample-controls .inbox-sample-draw, .inbox-page .inbox-continue { justify-content: center; color: oklch(100% 0 0); background: var(--signal-fill); }
.inbox-sample-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-top: 16px; }
.inbox-sample-list { margin-top: 8px; }
.inbox-page .inbox-sample-list button { border-top: 1px solid var(--line); border-radius: 0; background: transparent; box-shadow: none; }
.inbox-sample-list button > span:last-child { flex-shrink: 0; text-align: right; }
.inbox-sample-number { color: var(--ink-muted); font: var(--text-2xs) var(--font-data); }
.inbox-page .inbox-continue { margin: 8px 0; }
.inbox-sample-setup { margin: 8px 0; }
.inbox-view-switch { display: flex; flex-wrap: wrap; gap: 2px; margin-top: 12px; border-bottom: 1px solid var(--seam); }
.inbox-page .inbox-view-switch button { width: auto; min-width: 80px; justify-content: center; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; box-shadow: none; }
.inbox-page .inbox-view-switch button[aria-pressed="true"] { color: var(--ink); border-bottom-color: var(--signal); }
.inbox-view-switch span { font: var(--text-2xs) var(--font-data); }
.inbox-filter-summary, .inbox-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--ink-secondary); font-size: var(--text-xs); }
.inbox-page .inbox-filter-summary button, .inbox-page .inbox-section-heading button { width: auto; }
.inbox-section-heading h2 { margin: 0; color: var(--ink); }
.inbox-help { color: var(--ink-secondary); font-size: var(--text-xs); }
.inbox-page h2 span { color: var(--ink-secondary); font-size: var(--text-sm); font-weight: 450; }
@media (max-width: 920px) { .inbox-page { padding: 16px; } .inbox-header, .inbox-task { display: block; } .inbox-connection, .inbox-claims { margin-top: 12px; } }
@media (max-width: 600px) { .inbox-sample-controls { grid-template-columns: 1fr 1fr; } .inbox-filter-controls { grid-template-columns: 1fr; } .inbox-sample-heading { flex-direction: column; align-items: flex-start; gap: 6px; } .inbox-page .inbox-history-list button, .inbox-page .inbox-sample-list button { flex-direction: column; align-items: flex-start; gap: 3px; } .inbox-history-list button > span:last-child, .inbox-sample-list button > span:last-child { text-align: left; } }
</style>
