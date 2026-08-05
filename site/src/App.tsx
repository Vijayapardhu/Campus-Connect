import { useReducedMotion } from 'motion/react';
import { useSmoothScroll } from './lib/useSmoothScroll';
import { ScrollProgress } from './lib/effects';
import { Header } from './components/Chrome';
import { Footer } from './components/Footer';
import { Hero } from './components/Hero';
import { Campus, Features, Privacy } from './components/Sections';
import { Maker } from './components/Maker';
import { HowItWorks } from './components/HowItWorks';
import { Faq } from './components/Faq';
import { Download } from './components/Download';

export default function App() {
  const calm = useReducedMotion();
  useSmoothScroll(!calm);

  return (
    <>
      <ScrollProgress />
      <Header />
      <main>
        <Hero />
        <Campus />
        <Features />
        <HowItWorks />
        <Privacy />
        <Maker />
        <Faq />
        <Download />
      </main>
      <Footer />
    </>
  );
}
