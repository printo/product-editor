import type { Config } from "tailwindcss"

const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Brand purple ramp anchored at 600 = #64318E (the exact hex requested
        // to replace "all the blues"). Overriding Tailwind's own `indigo` scale
        // — rather than hand-editing every bg-indigo-*/hover:text-indigo-*
        // call site — means every existing button, focus ring, hover state,
        // and badge across the app picks up the new brand color for free.
        indigo: {
          50: '#F8F4FB',
          100: '#EEE4F6',
          200: '#DDCAED',
          300: '#C5A4E0',
          400: '#A877D0',
          500: '#8B49C0',
          600: '#64318E',
          700: '#502772',
          800: '#401F5B',
          900: '#331948',
          950: '#1D0E2A',
        },
      },
    },
  },
  plugins: [],
}
export default config
