<script lang="ts">
  import ActivityIcon from "@lucide/svelte/icons/activity";
  import { Button } from "$lib/components/ui/button/index.js";
</script>

<main class="mx-auto flex min-h-svh max-w-2xl flex-col items-center justify-center gap-6 px-4 text-center">
  <div class="flex items-center gap-3">
    <ActivityIcon class="size-8 text-primary" />
    <h1 class="text-3xl font-semibold tracking-tight">Earthquake Agent</h1>
  </div>
  <p class="text-muted-foreground">
    Customer self-service console for configuring earthquake monitoring,
    viewing briefing reports, and inspecting the agent conversation history.
  </p>
  <div class="flex flex-wrap items-center justify-center gap-2">
    <Button>Get started</Button>
    <Button variant="outline">View reports</Button>
  </div>
</main>
