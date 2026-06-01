<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import ActivityIcon from "@lucide/svelte/icons/activity";
  import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
  import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
  import WavesIcon from "@lucide/svelte/icons/waves";
  import BotIcon from "@lucide/svelte/icons/bot";
  import FileTextIcon from "@lucide/svelte/icons/file-text";
  import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import AlarmClockIcon from "@lucide/svelte/icons/alarm-clock";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import { auth, signIn } from "$lib/auth";
  import { fetchConversation } from "$lib/conversation/conversation-api.js";
  import { type TimelineItem } from "$lib/conversation/conversation.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import * as Card from "$lib/components/ui/card/index.js";

  type LoadState = "loading" | "ready" | "error";

  /** How often to poll for new conversation activity (Requirement 10.7). */
  const REFRESH_INTERVAL_MS = 30_000;

  let timeline = $state<TimelineItem[]>([]);
  let loadState = $state<LoadState>("loading");
  let loadError = $state<string | null>(null);
  let lastUpdated = $state<Date | null>(null);
  let refreshing = $state(false);

  // Poll bookkeeping: the interval handle and the in-flight request's
  // AbortController, so a slow request never overlaps the next tick and the
  // interval is always cleaned up on destroy.
  let intervalId: ReturnType<typeof setInterval> | undefined;
  let inFlight: AbortController | undefined;

  // Load (or refresh) the conversation. `isRefresh` keeps the existing timeline
  // visible (and shows a subtle refreshing indicator) instead of flashing the
  // full-page loader on every poll.
  async function load(isRefresh = false): Promise<void> {
    const customerId = auth.customerId;
    if (!customerId) {
      return;
    }

    // Cancel any still-in-flight poll so requests never overlap.
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;

    if (isRefresh) {
      refreshing = true;
    } else {
      loadState = "loading";
      loadError = null;
    }

    try {
      const items = await fetchConversation(customerId, controller.signal);
      // A newer request superseded this one; drop the stale result.
      if (inFlight !== controller) {
        return;
      }
      timeline = items;
      lastUpdated = new Date();
      loadState = "ready";
    } catch (err) {
      // Ignore aborts (a newer poll/refresh took over).
      if (controller.signal.aborted) {
        return;
      }
      if (isRefresh) {
        // Keep the last good timeline on a transient refresh failure.
        loadError = err instanceof Error ? err.message : String(err);
      } else {
        loadError = err instanceof Error ? err.message : String(err);
        loadState = "error";
      }
    } finally {
      if (inFlight === controller) {
        inFlight = undefined;
      }
      refreshing = false;
    }
  }

  // Start polling once authenticated; the interval is cleared on destroy and
  // whenever we (re)start to avoid duplicate timers.
  function startPolling(): void {
    stopPolling();
    intervalId = setInterval(() => {
      if (auth.isAuthenticated) {
        void load(true);
      }
    }, REFRESH_INTERVAL_MS);
  }

  function stopPolling(): void {
    if (intervalId !== undefined) {
      clearInterval(intervalId);
      intervalId = undefined;
    }
  }

  onMount(() => {
    if (auth.isAuthenticated) {
      void load();
      startPolling();
    }
  });

  // React to authentication completing after mount (the redirect callback runs
  // asynchronously in the root layout). Start the initial load + poller once.
  $effect(() => {
    if (auth.isAuthenticated && loadState === "loading" && !loadError) {
      void load();
      startPolling();
    }
  });

  onDestroy(() => {
    stopPolling();
    inFlight?.abort();
  });
</script>

<main class="mx-auto flex min-h-svh max-w-3xl flex-col gap-6 px-4 py-10">
  <div class="flex items-center gap-3">
    <ActivityIcon class="size-7 text-primary" />
    <h1 class="text-2xl font-semibold tracking-tight">Agent conversation</h1>
  </div>

  <a
    href="/"
    class="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1.5 text-sm"
  >
    <ArrowLeftIcon class="size-4" />
    Back to console
  </a>

  {#if auth.status === "loading"}
    <p class="text-muted-foreground text-sm">Loading…</p>
  {:else if !auth.isAuthenticated}
    <Card.Root>
      <Card.Header>
        <Card.Title>Sign in required</Card.Title>
        <Card.Description>
          You need to sign in before viewing the agent conversation history.
        </Card.Description>
      </Card.Header>
      <Card.Footer>
        <Button onclick={() => void signIn()}>Sign in</Button>
      </Card.Footer>
    </Card.Root>
  {:else if loadState === "loading"}
    <p class="text-muted-foreground flex items-center gap-2 text-sm">
      <LoaderCircleIcon class="size-4 animate-spin" />
      Loading the conversation…
    </p>
  {:else if loadState === "error"}
    <Card.Root>
      <Card.Header>
        <Card.Title>Couldn't load the conversation</Card.Title>
        <Card.Description>{loadError}</Card.Description>
      </Card.Header>
      <Card.Footer>
        <Button variant="outline" onclick={() => void load()}>Try again</Button>
      </Card.Footer>
    </Card.Root>
  {:else}
    <!-- Live status line: auto-refresh cadence + manual refresh (Req 10.7). -->
    <div
      class="text-muted-foreground flex flex-wrap items-center gap-2 text-xs"
    >
      <span class="inline-flex items-center gap-1.5">
        {#if refreshing}
          <LoaderCircleIcon class="size-3.5 animate-spin" />
          Refreshing…
        {:else}
          <span class="relative flex size-2">
            <span
              class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75"
            ></span>
            <span
              class="relative inline-flex size-2 rounded-full bg-emerald-500"
            ></span>
          </span>
          Live — auto-refreshes every 30s
        {/if}
      </span>
      {#if lastUpdated}
        <span aria-hidden="true">·</span>
        <span>Updated {lastUpdated.toLocaleTimeString()}</span>
      {/if}
      <Button
        variant="ghost"
        size="sm"
        class="ml-auto h-7 px-2"
        onclick={() => void load(true)}
        disabled={refreshing}
      >
        <RefreshCwIcon class="size-3.5" />
        Refresh
      </Button>
    </div>

    {#if loadError}
      <p class="text-destructive text-xs">
        Last refresh failed: {loadError}
      </p>
    {/if}

    {#if timeline.length === 0}
      <Card.Root>
        <Card.Header>
          <Card.Title>No activity yet</Card.Title>
          <Card.Description>
            When earthquakes matching your filters arrive, the agent's analysis
            will appear here as a live timeline. This view refreshes
            automatically, so you can leave it open and watch events come in.
          </Card.Description>
        </Card.Header>
      </Card.Root>
    {:else}
      <ol class="flex flex-col gap-4">
        {#each timeline as item (item.id)}
          <li>
            {#if item.kind === "earthquake"}
              <!-- User message (earthquake injection) -> event card. -->
              <Card.Root class="border-amber-500/40 bg-amber-500/5">
                <Card.Header>
                  <Card.Title class="flex items-center gap-2 text-base">
                    <WavesIcon class="size-4 text-amber-600" />
                    Earthquake detected
                    {#if item.earthquake.magnitude}
                      <Badge variant="secondary">
                        M {item.earthquake.magnitude}
                      </Badge>
                    {/if}
                  </Card.Title>
                  {#if item.earthquake.place}
                    <Card.Description>{item.earthquake.place}</Card.Description>
                  {/if}
                </Card.Header>
                <Card.Content>
                  <dl
                    class="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3"
                  >
                    {#if item.earthquake.time}
                      <div class="flex flex-col">
                        <dt class="text-muted-foreground text-xs">Time</dt>
                        <dd>{item.earthquake.time}</dd>
                      </div>
                    {/if}
                    {#if item.earthquake.depth}
                      <div class="flex flex-col">
                        <dt class="text-muted-foreground text-xs">Depth</dt>
                        <dd>{item.earthquake.depth}</dd>
                      </div>
                    {/if}
                    {#if item.earthquake.coordinates}
                      <div class="flex flex-col">
                        <dt class="text-muted-foreground text-xs">
                          Coordinates
                        </dt>
                        <dd>{item.earthquake.coordinates}</dd>
                      </div>
                    {/if}
                    {#if item.earthquake.tsunami}
                      <div class="flex flex-col">
                        <dt class="text-muted-foreground text-xs">Tsunami</dt>
                        <dd>{item.earthquake.tsunami}</dd>
                      </div>
                    {/if}
                    {#if item.earthquake.alert}
                      <div class="flex flex-col">
                        <dt class="text-muted-foreground text-xs">
                          PAGER alert
                        </dt>
                        <dd>{item.earthquake.alert}</dd>
                      </div>
                    {/if}
                    {#if item.earthquake.felt}
                      <div class="flex flex-col">
                        <dt class="text-muted-foreground text-xs">Felt</dt>
                        <dd>{item.earthquake.felt}</dd>
                      </div>
                    {/if}
                  </dl>
                  {#if item.earthquake.url}
                    <a
                      href={item.earthquake.url}
                      target="_blank"
                      rel="noreferrer"
                      class="text-primary mt-3 inline-block text-xs hover:underline"
                    >
                      View on USGS
                    </a>
                  {/if}
                </Card.Content>
              </Card.Root>
            {:else if item.kind === "user-text"}
              <!-- Other user message (e.g. the briefing trigger prompt). -->
              <div class="flex justify-end">
                <div
                  class="bg-muted text-muted-foreground max-w-[85%] rounded-2xl rounded-br-sm px-4 py-2 text-sm"
                >
                  {#if item.isBriefingTrigger}
                    <span class="flex items-center gap-2">
                      <AlarmClockIcon class="size-4" />
                      Briefing requested
                    </span>
                  {:else}
                    <p class="whitespace-pre-line">{item.text}</p>
                  {/if}
                </div>
              </div>
            {:else if item.kind === "assistant"}
              <!-- Assistant message (LLM analysis) -> agent response bubble. -->
              <div class="flex items-start gap-2">
                <div
                  class="bg-primary/10 text-primary mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full"
                >
                  <BotIcon class="size-4" />
                </div>
                <div
                  class="bg-card max-w-[85%] rounded-2xl rounded-tl-sm border px-4 py-2 text-sm"
                >
                  <p class="whitespace-pre-line">{item.text}</p>
                </div>
              </div>
            {:else if item.kind === "tool-use"}
              <!-- Tool use (save_report) -> action card. -->
              <Card.Root class="border-primary/30 bg-primary/5">
                <Card.Header>
                  <Card.Title class="flex items-center gap-2 text-sm">
                    <FileTextIcon class="size-4 text-primary" />
                    {item.summary}
                  </Card.Title>
                  <Card.Description class="font-mono text-xs">
                    {item.toolName}
                  </Card.Description>
                </Card.Header>
              </Card.Root>
            {:else if item.kind === "tool-result"}
              <!-- Tool result -> confirmation badge. -->
              <div class="flex justify-start">
                {#if item.status === "success"}
                  <Badge
                    variant="secondary"
                    class="gap-1.5 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                  >
                    <CircleCheckIcon class="size-3.5" />
                    {item.summary}
                    {#if item.reportId}
                      <a
                        href={`/reports/${item.reportId}`}
                        class="underline underline-offset-2"
                      >
                        View report
                      </a>
                    {/if}
                  </Badge>
                {:else}
                  <Badge variant="destructive" class="gap-1.5">
                    <TriangleAlertIcon class="size-3.5" />
                    {item.summary}
                  </Badge>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  {/if}
</main>
