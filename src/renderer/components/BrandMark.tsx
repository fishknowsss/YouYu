import iconUrl from '../assets/youyu-icon.png';

type BrandMarkProps = {
  size?: 'sm' | 'md' | 'lg';
};

export function BrandMark({ size = 'md' }: BrandMarkProps) {
  return <img className={`brand-mark brand-mark-${size}`} src={iconUrl} alt="YouYu" />;
}
