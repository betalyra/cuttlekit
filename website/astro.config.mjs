// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    resolve: {
      alias: {
        "@assets": path.resolve(__dirname, "../assets"),
      },
    },
  },
  integrations: [
    starlight({
      title: "cuttlekit",
      logo: {
        src: "../assets/logo-text-2.svg",
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
