/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: '#0b0e11',
        card: '#1e2329',
        input: '#2b3139',
        accent: '#f0b90b',
        long: '#0ecb81',
        short: '#f6465d',
        neutral: '#848e9c',
        'text-primary': '#eaecef',
        'text-secondary': '#848e9c',
      },
      fontFamily: {
        sans: ['IBM Plex Sans', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
}
