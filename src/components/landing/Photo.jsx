// The real photographs in public/landing. Each has a small file and a larger file made from the
// original render, so full-width uses stay sharp. Dimensions are the small file's, which reserves the
// space and keeps the layout from shifting while the image loads.
const PHOTOS = {
  serviceCall: { name: 'hvac-service-call', width: 1100, height: 733, largeWidth: 1536 },
  afterHours: { name: 'hvac-after-hours', width: 1100, height: 688, largeWidth: 1586 },
  betweenJobs: { name: 'hvac-between-jobs', width: 880, height: 1100, largeWidth: 1122 },
  withCustomer: { name: 'pain-customer', width: 880, height: 1100, largeWidth: 1122 },
  onTheRoad: { name: 'pain-road', width: 880, height: 1100, largeWidth: 1122 },
  underSink: { name: 'pain-job', width: 880, height: 1100, largeWidth: 1122 },
};

/** @param {{photo: keyof typeof PHOTOS, alt: string, sizes: string, className?: string, priority?: boolean}} props */
export function Photo({ photo, alt, sizes, className = undefined, priority = false }) {
  const { name, width, height, largeWidth } = PHOTOS[photo];
  return <img
    className={className}
    src={`/landing/${name}.jpg`}
    srcSet={`/landing/${name}.jpg ${width}w, /landing/${name}-large.jpg ${largeWidth}w`}
    sizes={sizes}
    width={width}
    height={height}
    alt={alt}
    {...(priority ? { fetchPriority: 'high' } : { loading: 'lazy', decoding: 'async' })}
  />;
}
