<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import ActivityIcon from "@lucide/svelte/icons/activity";
  import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
  import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
  import { auth, signIn } from "$lib/auth";
  import { fetchReport } from "$lib/reports/reports-api.js";
  import {
    formatMagnitude,
    formatPeriod,
    formatTimestamp,
    type BriefingReport,
  } from "$lib/reports/reports.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";
  import * as Card from "$lib/components/ui/card/index.js";

  type LoadState = "loading" | "ready" | "notfound" | "error";

  const reportId = $derived(page.params.reportId ?? "");

  let report = $state<BriefingReport | null>(null);
  let loadState = $state<LoadState>("loading");
  let loadError = $state<string | null>(null);

  // Load the full report for the customer + reportId in the URL.
  async function load(): Promise<void> {
    const customerId = auth.customerId;
    if (!customerId || !reportId) {
      return;
    }
    loadState = "loading";
    loadError = null;
    try {
      const result = await fetchReport(customerId, reportId);
      if (!result) {
        loadState = "notfound";
        return;
      }
      report = result;
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
</script>

<main class="mx-auto flex min-h-svh max-w-3xl flex-col gap-6 px-4 py-10">
  <div class="flex items-center gap-3">
    <ActivityIcon class="size-7 text-primary" />
    <h1 class="text-2xl font-semibold tracking-tight">Briefing report</h1>
  </div>

  <a
    href="/reports"
    class="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1.5 text-sm"
  >
    <ArrowLeftIcon class="size-4" />
    Back to reports
  </a>

  {#if auth.status === "loading"}
    <p class="text-muted-foreground text-sm">Loading…</p>
  {:else if !auth.isAuthenticated}
    <Card.Root>
      <Card.Header>
        <Card.Title>Sign in required</Card.Title>
        <Card.Description>
          You need to sign in before viewing this briefing report.
        </Card.Description>
      </Card.Header>
      <Card.Footer>
        <Button onclick={() => void signIn()}>Sign in</Button>
      </Card.Footer>
    </Card.Root>
  {:else if loadState === "loading"}
    <p class="text-muted-foreground flex items-center gap-2 text-sm">
      <LoaderCircleIcon class="size-4 animate-spin" />
      Loading report…
    </p>
  {:else if loadState === "notfound"}
    <Card.Root>
      <Card.Header>
        <Card.Title>Report not found</Card.Title>
        <Card.Description>
          This report doesn't exist or is no longer available.
        </Card.Description>
      </Card.Header>
      <Card.Footer>
        <Button variant="outline" href="/reports">Back to reports</Button>
      </Card.Footer>
    </Card.Root>
  {:else if loadState === "error"}
    <Card.Root>
      <Card.Header>
        <Card.Title>Couldn't load this report</Card.Title>
        <Card.Description>{loadError}</Card.Description>
      </Card.Header>
      <Card.Footer>
        <Button variant="outline" onclick={() => void load()}>Try again</Button>
      </Card.Footer>
    </Card.Root>
  {:else if report}
    <!-- Overview -->
    <Card.Root>
      <Card.Header>
        <Card.Title>{formatTimestamp(report.generatedAt)}</Card.Title>
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
        <p class="text-sm whitespace-pre-line">{report.summary}</p>
      </Card.Content>
    </Card.Root>

    <!-- Notable quakes -->
    <Card.Root>
      <Card.Header>
        <Card.Title>Notable earthquakes</Card.Title>
        <Card.Description>
          Significant events highlighted for this period.
        </Card.Description>
      </Card.Header>
      <Card.Content>
        {#if report.notableQuakes.length === 0}
          <p class="text-muted-foreground text-sm">
            No notable earthquakes were highlighted for this period.
          </p>
        {:else}
          <ul class="flex flex-col">
            {#each report.notableQuakes as quake, i (quake.earthquakeId)}
              {#if i > 0}
                <Separator class="my-3" />
              {/if}
              <li class="flex flex-col gap-1">
                <div class="flex flex-wrap items-center gap-2">
                  <Badge>M {formatMagnitude(quake.magnitude)}</Badge>
                  <span class="font-medium">{quake.place}</span>
                </div>
                <p class="text-muted-foreground text-sm">{quake.reason}</p>
              </li>
            {/each}
          </ul>
        {/if}
      </Card.Content>
    </Card.Root>

    <!-- Geographic patterns -->
    <Card.Root>
      <Card.Header>
        <Card.Title>Geographic patterns</Card.Title>
        <Card.Description>Analysis of geographic clustering.</Card.Description>
      </Card.Header>
      <Card.Content>
        <p class="text-sm whitespace-pre-line">{report.geographicPatterns}</p>
      </Card.Content>
    </Card.Root>

    <!-- Comparison to previous period -->
    <Card.Root>
      <Card.Header>
        <Card.Title>Comparison to previous period</Card.Title>
        <Card.Description>How this period compares to the last.</Card.Description>
      </Card.Header>
      <Card.Content>
        <p class="text-sm whitespace-pre-line">{report.comparisonToPrevious}</p>
      </Card.Content>
    </Card.Root>
  {/if}
</main>
