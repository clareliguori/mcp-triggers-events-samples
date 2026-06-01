<script lang="ts">
  import ActivityIcon from "@lucide/svelte/icons/activity";
  import LogOutIcon from "@lucide/svelte/icons/log-out";
  import { Button } from "$lib/components/ui/button/index.js";
  import { auth, signIn, signUp, signOut } from "$lib/auth";
</script>

<main
  class="mx-auto flex min-h-svh max-w-2xl flex-col items-center justify-center gap-6 px-4 text-center"
>
  <div class="flex items-center gap-3">
    <ActivityIcon class="size-8 text-primary" />
    <h1 class="text-3xl font-semibold tracking-tight">Earthquake Agent</h1>
  </div>
  <p class="text-muted-foreground">
    Customer self-service console for configuring earthquake monitoring, viewing
    briefing reports, and inspecting the agent conversation history.
  </p>

  {#if auth.status === "loading"}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if auth.isAuthenticated}
    <div class="flex flex-col items-center gap-3">
      <p class="text-sm">
        Signed in{#if auth.email}
          as <span class="font-medium">{auth.email}</span>{/if}.
      </p>
      <p class="text-xs text-muted-foreground">
        Customer ID: <code>{auth.customerId}</code>
      </p>
      <div class="flex flex-wrap items-center justify-center gap-2">
        <Button href="/config">Configure monitoring</Button>
        <Button variant="outline" href="/reports">View reports</Button>
        <Button variant="ghost" onclick={() => void signOut()}>
          <LogOutIcon />
          Sign out
        </Button>
      </div>
    </div>
  {:else}
    <div class="flex flex-col items-center gap-3">
      {#if auth.error}
        <p class="text-sm text-destructive">{auth.error}</p>
      {/if}
      <div class="flex flex-wrap items-center justify-center gap-2">
        <Button onclick={() => void signIn()}>Sign in</Button>
        <Button variant="outline" onclick={() => void signUp()}>
          Create account
        </Button>
      </div>
    </div>
  {/if}
</main>
