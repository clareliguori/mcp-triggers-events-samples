<script lang="ts">
  import { onMount } from "svelte";
  import ActivityIcon from "@lucide/svelte/icons/activity";
  import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
  import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
  import { auth, signIn } from "$lib/auth";
  import { ApiError } from "$lib/api/client.js";
  import {
    REGIONS,
    REGION_LABELS,
    BRIEFING_SCHEDULES,
    scheduleLabel,
    emptyConfigForm,
    configToForm,
    validateConfigForm,
    type ConfigFormValues,
    type ConfigFormErrors,
  } from "$lib/config/customer-config.js";
  import {
    fetchCustomerConfig,
    putCustomerConfig,
  } from "$lib/config/config-api.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Select from "$lib/components/ui/select/index.js";

  type LoadState = "loading" | "ready" | "error";
  type SaveState = "idle" | "saving" | "saved" | "error";

  let form = $state<ConfigFormValues>(emptyConfigForm());
  let errors = $state<ConfigFormErrors>({});
  let loadState = $state<LoadState>("loading");
  let loadError = $state<string | null>(null);
  let saveState = $state<SaveState>("idle");
  let saveError = $state<string | null>(null);

  // The label shown in the region trigger; empty string means "all regions".
  const regionTriggerLabel = $derived(
    form.region === "" ? "All regions" : REGION_LABELS[form.region],
  );

  // Load the customer's existing config once authenticated. A 404 (no config
  // yet) is expected for first-time users and starts an empty form.
  async function load(): Promise<void> {
    const customerId = auth.customerId;
    if (!customerId) {
      return;
    }
    loadState = "loading";
    loadError = null;
    try {
      const config = await fetchCustomerConfig(customerId);
      form = config ? configToForm(config) : emptyConfigForm();
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

  async function handleSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const customerId = auth.customerId;
    if (!customerId) {
      saveState = "error";
      saveError = "You must be signed in to save your configuration.";
      return;
    }

    const result = validateConfigForm(form);
    if (!result.ok) {
      errors = result.errors;
      saveState = "idle";
      return;
    }
    errors = {};
    saveState = "saving";
    saveError = null;

    try {
      const saved = await putCustomerConfig(customerId, result.value);
      form = configToForm(saved);
      saveState = "saved";
    } catch (err) {
      saveState = "error";
      if (err instanceof ApiError) {
        saveError =
          err.status === 400
            ? `Validation failed: ${err.message}`
            : err.message;
      } else {
        saveError = err instanceof Error ? err.message : String(err);
      }
    }
  }
</script>

<main class="mx-auto flex min-h-svh max-w-2xl flex-col gap-6 px-4 py-10">
  <div class="flex items-center gap-3">
    <ActivityIcon class="size-7 text-primary" />
    <h1 class="text-2xl font-semibold tracking-tight">Monitoring configuration</h1>
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
          You need to sign in before configuring earthquake monitoring.
        </Card.Description>
      </Card.Header>
      <Card.Footer>
        <Button onclick={() => void signIn()}>Sign in</Button>
      </Card.Footer>
    </Card.Root>
  {:else if loadState === "loading"}
    <p class="text-muted-foreground flex items-center gap-2 text-sm">
      <LoaderCircleIcon class="size-4 animate-spin" />
      Loading your configuration…
    </p>
  {:else if loadState === "error"}
    <Card.Root>
      <Card.Header>
        <Card.Title>Couldn't load your configuration</Card.Title>
        <Card.Description>{loadError}</Card.Description>
      </Card.Header>
      <Card.Footer>
        <Button variant="outline" onclick={() => void load()}>Try again</Button>
      </Card.Footer>
    </Card.Root>
  {:else}
    <form class="flex flex-col gap-6" onsubmit={handleSubmit} novalidate>
      <Card.Root>
        <Card.Header>
          <Card.Title>Subscription</Card.Title>
          <Card.Description>
            Configure which earthquakes you want to monitor and how your
            briefings are generated.
          </Card.Description>
        </Card.Header>
        <Card.Content class="flex flex-col gap-5">
          <!-- Display name -->
          <div class="flex flex-col gap-2">
            <Label for="displayName">Display name</Label>
            <Input
              id="displayName"
              placeholder="e.g. West Coast Operations"
              bind:value={form.displayName}
              aria-invalid={errors.displayName ? "true" : undefined}
            />
            {#if errors.displayName}
              <p class="text-destructive text-sm">{errors.displayName}</p>
            {/if}
          </div>

          <!-- Minimum magnitude -->
          <div class="flex flex-col gap-2">
            <Label for="minMagnitude">Minimum magnitude</Label>
            <Input
              id="minMagnitude"
              type="number"
              inputmode="decimal"
              min="0"
              max="10"
              step="0.1"
              placeholder="No minimum (all magnitudes)"
              bind:value={form.minMagnitude}
              aria-invalid={errors.minMagnitude ? "true" : undefined}
            />
            <p class="text-muted-foreground text-xs">
              Only deliver earthquakes at or above this magnitude. Leave blank
              to receive all magnitudes.
            </p>
            {#if errors.minMagnitude}
              <p class="text-destructive text-sm">{errors.minMagnitude}</p>
            {/if}
          </div>

          <!-- Region -->
          <div class="flex flex-col gap-2">
            <Label for="region">Region</Label>
            <Select.Root type="single" bind:value={form.region}>
              <Select.Trigger id="region" class="w-full">
                {regionTriggerLabel}
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="">All regions</Select.Item>
                {#each REGIONS as region (region)}
                  <Select.Item value={region} label={REGION_LABELS[region]}>
                    {REGION_LABELS[region]}
                  </Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
            <p class="text-muted-foreground text-xs">
              Restrict deliveries to a geographic region, or monitor all regions.
            </p>
            {#if errors.region}
              <p class="text-destructive text-sm">{errors.region}</p>
            {/if}
          </div>

          <!-- Max depth -->
          <div class="flex flex-col gap-2">
            <Label for="maxDepthKm">Maximum depth (km)</Label>
            <Input
              id="maxDepthKm"
              type="number"
              inputmode="decimal"
              min="0"
              step="1"
              placeholder="No maximum (any depth)"
              bind:value={form.maxDepthKm}
              aria-invalid={errors.maxDepthKm ? "true" : undefined}
            />
            <p class="text-muted-foreground text-xs">
              Only deliver earthquakes shallower than this depth. Leave blank for
              any depth.
            </p>
            {#if errors.maxDepthKm}
              <p class="text-destructive text-sm">{errors.maxDepthKm}</p>
            {/if}
          </div>
        </Card.Content>
      </Card.Root>

      <Card.Root>
        <Card.Header>
          <Card.Title>Briefings</Card.Title>
          <Card.Description>
            Customize how your periodic briefing reports are written and when
            they run.
          </Card.Description>
        </Card.Header>
        <Card.Content class="flex flex-col gap-5">
          <!-- Briefing prompt -->
          <div class="flex flex-col gap-2">
            <Label for="briefingPrompt">Briefing prompt</Label>
            <Textarea
              id="briefingPrompt"
              rows={6}
              placeholder="e.g. You are a seismic analyst. Summarize notable activity for an emergency operations team…"
              bind:value={form.briefingPrompt}
              aria-invalid={errors.briefingPrompt ? "true" : undefined}
            />
            <p class="text-muted-foreground text-xs">
              Used as the system prompt when the agent synthesizes your briefing
              report (max 2000 characters).
            </p>
            {#if errors.briefingPrompt}
              <p class="text-destructive text-sm">{errors.briefingPrompt}</p>
            {/if}
          </div>

          <!-- Briefing schedule -->
          <div class="flex flex-col gap-2">
            <Label for="briefingSchedule">Briefing schedule</Label>
            <Select.Root type="single" bind:value={form.briefingSchedule}>
              <Select.Trigger id="briefingSchedule" class="w-full">
                {scheduleLabel(form.briefingSchedule)}
              </Select.Trigger>
              <Select.Content>
                {#each BRIEFING_SCHEDULES as schedule (schedule.cron)}
                  <Select.Item value={schedule.cron} label={schedule.label}>
                    {schedule.label}
                  </Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
            <p class="text-muted-foreground text-xs">
              How often the agent generates a briefing report from accumulated
              earthquake data.
            </p>
            {#if errors.briefingSchedule}
              <p class="text-destructive text-sm">{errors.briefingSchedule}</p>
            {/if}
          </div>
        </Card.Content>
      </Card.Root>

      <div class="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={saveState === "saving"}>
          {#if saveState === "saving"}
            <LoaderCircleIcon class="size-4 animate-spin" />
            Saving…
          {:else}
            Save configuration
          {/if}
        </Button>
        {#if saveState === "saved"}
          <p class="text-sm text-emerald-600 dark:text-emerald-400">
            Configuration saved.
          </p>
        {:else if saveState === "error"}
          <p class="text-destructive text-sm">{saveError}</p>
        {/if}
      </div>
    </form>
  {/if}
</main>
