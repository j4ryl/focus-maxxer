export const videos = [
  {
    id: 'gta',
    label: 'GTA',
    src: '/videos/gta.mp4',
    color: '#46f0a9',
  },
  {
    id: 'subway',
    label: 'Subway',
    src: '/videos/subway.mp4',
    color: '#ffe45e',
  },
  {
    id: 'sand',
    label: 'Sand',
    src: '/videos/sand.mp4',
    color: '#ff8f70',
  },
  {
    id: 'family',
    label: 'Family',
    src: '/videos/family.mp4',
    color: '#7cc8ff',
  },
];

export const defaultVideoId = videos[0].id;

export function getVideoById(id) {
  return videos.find((video) => video.id === id) ?? videos[0];
}
