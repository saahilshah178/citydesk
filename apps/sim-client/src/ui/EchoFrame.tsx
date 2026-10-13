import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { DEVICE_HEIGHT, DEVICE_WIDTH } from './layout.ts';

/** A 1280x800 landscape screen in a bezel, scaled as one piece to fit the space it is given. */
export function EchoFrame({ children }: { children: ReactNode }) {
  const fitRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const element = fitRef.current;
    if (!element) return undefined;
    const update = (): void => {
      const { width, height } = element.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      // Upscaling past 1.4 only blurs the cards; below that, fit whichever side is tighter.
      setScale(Math.max(0.2, Math.min(width / DEVICE_WIDTH, height / DEVICE_HEIGHT, 1.4)));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="device-fit" ref={fitRef}>
      <div className="device-box" style={{ width: DEVICE_WIDTH * scale, height: DEVICE_HEIGHT * scale }}>
        <div className="device" style={{ transform: `scale(${scale})` }}>
          <div className="screen">{children}</div>
        </div>
      </div>
    </div>
  );
}
