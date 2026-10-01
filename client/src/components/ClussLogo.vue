<template>
  <svg class="cluss-logo" :width="size" :height="size" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="2" y="2" width="44" height="44" rx="14" fill="url(#clussLogoGradient)" />
    <path
      d="M31.5 17.8a9.6 9.6 0 1 0 0 12.4"
      stroke="#ffffff"
      stroke-width="3.6"
      stroke-linecap="round"
      fill="none"
    />
    <circle cx="33.6" cy="24" r="2.6" fill="#ffffff" />
    <defs>
      <linearGradient id="clussLogoGradient" x1="4" y1="2" x2="44" y2="46" gradientUnits="userSpaceOnUse">
        <stop stop-color="#5b9bff" />
        <stop offset="1" stop-color="#2f6bdd" />
      </linearGradient>
    </defs>
  </svg>
</template>

<script>
export default {
  name: 'ClussLogo',
  props: {
    size: {
      type: [Number, String],
      default: 40
    }
  }
};
</script>

<style scoped>
.cluss-logo {
  display: block;
  flex-shrink: 0;
}
</style>