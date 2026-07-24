type QoderLogoProps = {
  className?: string;
};

const QoderLogo = ({ className = 'w-5 h-5' }: QoderLogoProps) => (
  <svg
    viewBox="0 0 24 24"
    role="img"
    aria-label="Qoder"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="2.5" y="2.5" width="19" height="19" rx="4" className="fill-foreground" />
    <path
      d="M7 8.5h10M7 12h7M7 15.5h10"
      className="stroke-background"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="17.5" cy="15.5" r="2.5" className="stroke-background" strokeWidth="1.9" />
    <path d="M19.3 17.3 21 19" className="stroke-background" strokeWidth="1.9" strokeLinecap="round" />
  </svg>
);

export default QoderLogo;
