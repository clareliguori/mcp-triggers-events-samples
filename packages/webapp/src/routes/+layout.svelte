<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  import { handleRedirectCallback } from "$lib/auth";

  let { children } = $props();

  // Complete a returning Cognito Hosted UI redirect (authorization code + PKCE)
  // exactly once when the SPA mounts. Tokens are stored in memory only.
  onMount(() => {
    void handleRedirectCallback();
  });
</script>

{@render children?.()}
