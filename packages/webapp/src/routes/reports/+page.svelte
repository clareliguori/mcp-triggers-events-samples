<script lang="ts">
  import { onMount } from "svelte";
  import ActivityIcon from "@lucide/svelte/icons/activity";
  import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
  import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
  import { auth, signIn } from "$lib/auth";
  import { ApiError } from "$lib/api/client.js";
  import {
    fetchReports,
    triggerBriefing,
  } from "$lib/reports/reports-api.js";
  import {
    formatPeriod,
    formatTimestamp,
    type ReportSummary,
  } from "$lib/reports/reports.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import * as Card from "$lib/components/ui/card/index.js";

  type LoadState = "loading" | "ready" | "error";
  type TriggerState = "idle" | "triggering" | "triggered" | "error";

  let reports = $state<ReportSummary[]>([]);
  let loadState = $state<LoadState>("loading");
  let loadError = $state<string | null>(null);
  let triggerState = $state<TriggerState>("idle");
  let triggerError = $state<string | null>(null);

  // Load the customer's report list once authenticated.
  async function load(): Promise<void> {
    const customerId = auth.customerId;
    if (!customerId) {
      return;
    }
    loadState = "loading";
    loadError = null;
    try {
      reports = await fetchReports(customerId);
      loadState = "ready";
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
      loadState = "error";
    }
  }

  onMount(() => {
    if (auth.isAuthenticated) {
      void load();
    }
  });

  // React to authentication completing after mount (the redirect callback runs
  // asynchronously in the root layout).
  $effect(() => {
    if (auth.isAuthenticated && loadState === "loading" && !loadError) {
      void load();
    }
  });

  // Request an immediate briefing (Requirement 10.5). On success, reload the
  // list after a short delay so a freshly generated report can appear.
  async function handleTrigger(): Promise<void> {
    const customerId = auth.customerId;
    if (!customerId) {
      triggerState = "error";
      triggerError = "You must be signed in to trigger a briefing.";
      return;
    }
    triggerState = "triggering";
    triggerError = null;
    try {
      await triggerBriefing(customerId);
      triggerState = "triggered";
    } catch (err) {
      triggerState = "error";
      triggerError =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
    }
  }
</script>

<main class="mx-auto flex min-h-svh max-w-3xl flex-col gap-6 px-4 py-10">
  <div class="flex items-center gap-3">
    <ActivityIcon class="size-7 text-primary" />
    <h1 class="text-2xl font-semibold tracking-tight">Briefing reports</h1>
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
          You need to sign in before viewing your briefing reports.
        </Card.Description>
      </Card.Header>
      <Card.Footer>
        <Button onclick={() => void signIn()}>Sign in</Button>
      </Card.Footer>
    </Card.Root>
  {:else}
    <!-- Manual trigger (Requirement 10.5) -->
    <Card.Root>
      <Card.Header>
        <Card.Title>Generate a briefing now</Card.Title>
        <Card.Description>
          Trigger an immediate briefing instead of waiting for your scheduled
          run. It may take a moment for the new report to appear below.
        </Card.Description>
      </Card.Header>
      <Card.Footer class="flex flex-wrap items-center gap-3">
        <Button onclick={() => void handleTrigger()} disabled={triggerState === "triggering"}>
          {#if triggerState === "triggering"}
            <LoaderCircleIcon class="size-4 animate-spin" />
            Triggering…
          {:else}
            Trigger Briefing Now
          {/if}
        </Button>
        {#if triggerState === "triggered"}
          <p class="text-sm text-emerald-600 dark:text-emerald-400">
            Briefing requested.
          </p>
          <Button variant="outline" size="sm" onclick={() => void load()}>
            Refresh list
          </Button>
        {:else if triggerState === "error"}
          <p class="text-destructive text-sm">{triggerError}</p>
        {/if}
      </Card.Footer>
    </Card.Root>

    {#if loadState === "loading"}
      <p class="text-muted-foreground flex items-center gap-2 text-sm">
        <LoaderCircleIcon class="size-4 animate-spin" />
        Loading your reports…
      </p>
    {:else if loadState === "error"}
      <Card.Root>
        <Card.Header>
          <Card.Title>Couldn't load your reports</Card.Title>
          <Card.Description>{loadError}</Card.Description>
        </Card.Header>
        <Card.Footer>
          <Button variant="outline" onclick={() => void load()}>Try again</Button>
        </Card.Footer>
      </Card.Root>
    {:else if reports.length === 0}
      <Card.Root>
        <Card.Header>
          <Card.Title>No reports yet</Card.Title>
          <Card.Description>
            Once a briefing is generated — on your schedule or via the button
            above — it will show up here.
          </Card.Description>
        </Card.Header>
      </Card.Root>
    {:else}
      <ul class="flex flex-col gap-3">
        {#each reports as report (report.reportId)}
          <li>
            <a
              href={`/reports/${report.reportId}`}
              class="focus-visible:ring-ring block rounded-xl outline-none focus-visible:ring-[3px]"
            >
              <Card.Root class="hover:ring-foreground/20 transition-[box-shadow]">
                <Card.Header>
                  <Card.Title class="text-base">
                    {formatTimestamp(report.generatedAt)}
                  </Card.Title>
                  <Card.Description>
                    {formatPeriod(report.periodStart, report.periodEnd)}
                  </Card.Description>
                  <Card.Action>
                    <Badge variant="secondary">
                      {report.totalEarthquakes}
                      {report.totalEarthquakes === 1 ? "quake" : "quakes"}
                    </Badge>
                  </Card.Action>
                </Card.Header>
                <Card.Content>
                  <p class="text-muted-foreground line-clamp-3 text-sm">
                    {report.summary}
                  </p>
                </Card.Content>
              </Card.Root>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</main>
