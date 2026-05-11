/** @type {import('tailwindcss').Config} */
const colors = [
  "violet", "fuchsia", "indigo", "sky", "emerald", "teal",
  "amber", "rose", "neutral", "ink",
  "blue", "green", "yellow", "orange", "red", "cyan", "lime",
];
const shades = ["50", "100", "200", "300", "400", "500", "600", "700"];
const safelist = [];
for (const c of colors) {
  for (const s of shades) {
    safelist.push(`bg-${c}-${s}`, `text-${c}-${s}`, `border-${c}-${s}`, `ring-${c}-${s}`);
  }
}
safelist.push(...[
  "bg-rose-50/60", "bg-emerald-50/60", "bg-amber-50/60",
  "border-rose-200", "border-emerald-200", "border-amber-200",
  "from-violet-400", "to-fuchsia-400", "from-sky-400", "to-emerald-400",
  "from-amber-400", "to-rose-400", "from-indigo-400", "to-cyan-400",
  "from-rose-400", "to-fuchsia-400", "from-emerald-400", "to-teal-400",
  "from-violet-500", "to-fuchsia-500",
]);

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  safelist,
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        ink: {
          900: '#0f172a',
          700: '#334155',
          500: '#64748b',
          300: '#cbd5e1',
        },
      },
      backgroundImage: {
        'dot-grid': 'radial-gradient(circle at 1px 1px, rgba(15,23,42,0.08) 1px, transparent 0)',
      },
      backgroundSize: {
        'dot-grid': '20px 20px',
      },
      boxShadow: {
        'soft': '0 1px 2px rgba(15,23,42,0.04), 0 1px 3px rgba(15,23,42,0.05)',
        'card': '0 1px 2px rgba(15,23,42,0.05), 0 4px 12px rgba(15,23,42,0.05)',
      },
    },
  },
  plugins: [],
};
