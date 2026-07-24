import { Ubuntu } from 'next/font/google';

// Site-chrome typeface (template names, headings, descriptions) — distinct
// from GoogleFontLinks, which loads fonts the *customer* picks for canvas text.
// 300/500/700 loaded: light body text, medium headings, bold template names.
// Add a weight here before using a new font-* class with this font, or the
// browser will synthesize (fake-bold) it.
export const ubuntu = Ubuntu({
  subsets: ['latin'],
  weight: ['300', '500', '700'],
  variable: '--font-ubuntu',
});
