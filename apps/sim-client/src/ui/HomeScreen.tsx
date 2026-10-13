/** The idle screen: the time, the city, and a few things a resident could say. */

export const EXAMPLE_PHRASES = [
  'There is a pothole on Boylston Street near the library',
  'When do trash and recycling go out at 700 Boylston Street?',
  'Has anyone reported the broken streetlight at Copley Square?',
  'What is happening with my requests?',
];

interface HomeScreenProps {
  now: Date;
  timeZone: string;
  cityName: string;
  /** Tapping a phrase asks it, which is the quickest way to try the assistant without a microphone. */
  onPhrase: (phrase: string) => void;
  disabled: boolean;
}

export function HomeScreen({ now, timeZone, cityName, onPhrase, disabled }: HomeScreenProps) {
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(now);
  const date = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'long', day: 'numeric' }).format(now);

  return (
    <div className="home">
      <div className="home__clock">
        <p className="home__time">{time}</p>
        <p className="home__date">
          {date} &middot; {cityName}
        </p>
      </div>
      <div className="home__try">
        <p className="eyebrow">Try saying</p>
        <ul>
          {EXAMPLE_PHRASES.map((phrase) => (
            <li key={phrase}>
              <button type="button" onClick={() => onPhrase(phrase)} disabled={disabled}>
                &ldquo;{phrase}&rdquo;
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
