/**
 * Tailwind is here only for the /downloader ?variant= prototypes. It processes
 * files that import it; app/globals.css has no Tailwind directives and is left
 * exactly as it was.
 */
export default {
  plugins: { "@tailwindcss/postcss": {} },
};
