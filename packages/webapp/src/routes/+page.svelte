<script lang="ts">
  import ActivityIcon from "@lucide/svelte/icons/activity";
  import LogOutIcon from "@lucide/svelte/icons/log-out";
  import RadioIcon from "@lucide/svelte/icons/radio";
  import BrainCircuitIcon from "@lucide/svelte/icons/brain-circuit";
  import FileTextIcon from "@lucide/svelte/icons/file-text";
  import ShieldCheckIcon from "@lucide/svelte/icons/shield-check";
  import { Button } from "$lib/components/ui/button/index.js";
  import { auth, signIn, signUp, signOut } from "$lib/auth";
</script>

{#if auth.status === "loading"}
  <main class="flex min-h-svh items-center justify-center">
    <p class="text-sm text-muted-foreground">Loading…</p>
  </main>
{:else if auth.isAuthenticated}
  <!-- Authenticated: compact dashboard hub -->
  <main
    class="mx-auto flex min-h-svh max-w-2xl flex-col items-center justify-center gap-6 px-4 text-center"
  >
    <div class="flex items-center gap-3">
      <ActivityIcon class="size-8 text-primary" />
      <h1 class="text-3xl font-semibold tracking-tight">Earthquake Agent</h1>
    </div>
    <div class="flex flex-col items-center gap-3">
      <p class="text-sm">
        Signed in{#if auth.email}{" "}as <span class="font-medium">{auth.email}</span>{/if}.
      </p>
      <p class="text-xs text-muted-foreground">
        Customer ID: <code>{auth.customerId}</code>
      </p>
      <div class="flex flex-wrap items-center justify-center gap-2">
        <Button href="/config">Configure monitoring</Button>
        <Button variant="outline" href="/reports">View reports</Button>
        <Button variant="outline" href="/conversation">View conversation</Button>
        <Button variant="ghost" onclick={() => void signOut()}>
          <LogOutIcon />
          Sign out
        </Button>
      </div>
    </div>
  </main>
{:else}
  <!-- Unauthenticated: landing page -->
  <main class="flex min-h-svh flex-col">
    <!-- Hero -->
    <section class="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-4 py-24">
      <!-- Decorative gradient orb -->
      <div
        class="pointer-events-none absolute -top-32 left-1/2 size-[600px] -translate-x-1/2 rounded-full opacity-20 blur-[120px]"
        style="background: radial-gradient(circle, oklch(0.5 0.1 175), oklch(0.75 0.13 85), transparent 70%);"
        aria-hidden="true"
      ></div>

      <div class="relative z-10 flex max-w-2xl flex-col items-center gap-6 text-center">
        <div class="flex items-center gap-3">
          <ActivityIcon class="size-10 text-primary" />
          <h1 class="text-4xl font-bold tracking-tight sm:text-5xl">
            Earthquake Agent
          </h1>
        </div>
        <p class="text-lg text-muted-foreground sm:text-xl">
          AI-powered earthquake monitoring that watches the planet so you don't
          have to. Get personalized briefings on seismic activity that matters
          to your region.
        </p>
        <div class="flex flex-wrap items-center justify-center gap-3 pt-2">
          <Button size="lg" onclick={() => void signIn()}>Get started</Button>
          <Button size="lg" variant="outline" onclick={() => void signUp()}>
            Create account
          </Button>
        </div>
      </div>
    </section>

    <!-- Features -->
    <section class="border-t bg-card px-4 py-16">
      <div class="mx-auto grid max-w-4xl gap-8 sm:grid-cols-2">
        <div class="flex gap-4">
          <div class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <RadioIcon class="size-5 text-primary" />
          </div>
          <div>
            <h3 class="font-semibold">Real-time detection</h3>
            <p class="mt-1 text-sm text-muted-foreground">
              Continuously monitors the USGS feed and delivers matching
              earthquakes filtered to your magnitude, depth, and region
              preferences.
            </p>
          </div>
        </div>
        <div class="flex gap-4">
          <div class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <BrainCircuitIcon class="size-5 text-primary" />
          </div>
          <div>
            <h3 class="font-semibold">AI analysis</h3>
            <p class="mt-1 text-sm text-muted-foreground">
              Each earthquake is analyzed by a Strands agent that maintains
              context across events, building a running picture of seismic
              activity.
            </p>
          </div>
        </div>
        <div class="flex gap-4">
          <div class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <FileTextIcon class="size-5 text-primary" />
          </div>
          <div>
            <h3 class="font-semibold">Scheduled briefings</h3>
            <p class="mt-1 text-sm text-muted-foreground">
              Get concise reports on your schedule or on demand. Customize
              the briefing prompt to match how your team consumes information.
            </p>
          </div>
        </div>
        <div class="flex gap-4">
          <div class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <ShieldCheckIcon class="size-5 text-primary" />
          </div>
          <div>
            <h3 class="font-semibold">Isolated &amp; secure</h3>
            <p class="mt-1 text-sm text-muted-foreground">
              Each customer has independent subscriptions, an isolated agent
              session, and private reports. Your data never leaks across
              accounts.
            </p>
          </div>
        </div>
      </div>
    </section>

    <!-- Footer -->
    <footer class="border-t px-4 py-6 text-center text-xs text-muted-foreground">
      Built with Strands Agents, MCP Events, and AWS serverless.
    </footer>
  </main>
{/if}
