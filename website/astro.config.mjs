// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";

// https://astro.build/config
export default defineConfig({
  site: "https://cuttlekit.dev",
  image: {
    service: {
      entrypoint: "astro/assets/services/noop",
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
  integrations: [
    starlight({
      title: "cuttlekit",
      logo: {
        src: "./src/assets/logo-text-2.svg",
        replacesTitle: true,
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/betalyra/cuttlekit",
        },
        {
          icon: "discord",
          label: "Discord",
          href: "https://discord.gg/ebtwHGcyXR",
        },
      ],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Introduction", slug: "introduction" },
          ],
        },
      ],
      customCss: ["./src/styles/global.css"],
      disable404Route: true,
    }),
  ],
});
