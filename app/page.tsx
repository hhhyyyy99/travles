import Header from '@/components/Header';
import IntroSection from '@/components/IntroSection';
import SummaryCards from '@/components/SummaryCards';
import JourneySection from '@/components/Journey/JourneySection';
import ReasonSection from '@/components/ReasonSection';
import PrepareSection from '@/components/PrepareSection';
import ChecklistSection from '@/components/ChecklistSection';
import SourcesSection from '@/components/SourcesSection';
import Footer from '@/components/Footer';
import PrintItinerary from '@/components/PrintItinerary';

export default function Home() {
  return (
    <>
      <Header />
      <main>
        <IntroSection />
        <SummaryCards />
        <JourneySection />
        <ReasonSection />
        <PrepareSection />
        <ChecklistSection />
        <SourcesSection />
      </main>
      <Footer />
      <PrintItinerary />
    </>
  );
}
