import type { Climb } from '@boardsesh/shared-schema';

// Real Kilter Original frame strings from the committed Aurora oracle fixture
// (packages/board-constants/src/__tests__/__fixtures__/aurora-frames-oracle.json).
// Counts, grades and setter names are deterministic presentation fixtures.
export const STORY_BOARD = {
  boardName: 'kilter',
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 7,
  setIds: '1,20',
  angle: 40,
  uuid: 'story-kilter-original',
  name: 'Kilter Original',
} as const;

export const STORY_ANIMATED_CLIMBS: Climb[] = [
  {
    uuid: '087E758319804A8181F6E540139D8829',
    name: 'kilter bueno 1 part1',
    frames:
      'p1213r12p1227r12p1265r13p1282r13p1320r13p1332r13p1532r15,"p1192r15p1213r15x1227x1282p1283r13p1295r13p1318r13x1320,"p1237r13p1241r13p1253r13x1295x1318x1332p1500r15p1508r15p1516r15x1532p1534r15,p1224r13p1241r13p1269r13p1286r13p1291r13p1500r15p1508r15,p1160r15p1231r14p1248r13p1269r13p1286r13',
    framesCount: 5,
    layoutId: 1,
    boardType: 'kilter',
    angle: 40,
    setter_username: 'Story climber',
    ascensionist_count: 120,
    difficulty: '6b/V4',
    quality_average: '4.5',
    stars: 4,
    difficulty_error: '0',
    benchmark_difficulty: null,
  },
  {
    uuid: '446C01713F37483A84FD060F98278158',
    name: 'FRE 20250608 1',
    frames:
      'p1169r12p1205r13p1219r13p1256r13p1289r15,p1289r15p1308r15p1340r13p1374r13p1388r13,p1335r13p1349r13p1354r15p1368r13p1388r15,p1348r15p1349r15p1363r13p1380r13p1383r13,p1297r13p1311r13p1347r15p1363r15,p1247r13p1267r13p1278r15p1281r13p1297r15,p1251r15p1267r15p1284r13p1302r13p1322r13p1337r13,p1322r15p1371r15p1375r13p1390r13p1393r13,p1288r13p1302r13p1323r13p1356r15p1393r15,p1225r14p1257r13p1275r13p1288r15p1289r15',
    framesCount: 10,
    layoutId: 1,
    boardType: 'kilter',
    angle: 40,
    setter_username: 'Story climber',
    ascensionist_count: 161,
    difficulty: '6b/V4',
    quality_average: '4.5',
    stars: 4,
    difficulty_error: '0',
    benchmark_difficulty: null,
  },
  {
    uuid: '2F64CA9CDDA2499AB74B97C15CE12E28',
    name: '+N手作（橫渡抱石題目）',
    frames:
      'p1143r13p1162r13p1174r12p1181r13p1187r13p1192r14p1193r13p1195r13p1198r13p1200r13p1201r13p1205r13p1206r12p1221r13,",",",","',
    framesCount: 6,
    layoutId: 1,
    boardType: 'kilter',
    angle: 40,
    setter_username: 'Story climber',
    ascensionist_count: 202,
    difficulty: '6b/V4',
    quality_average: '4.5',
    stars: 4,
    difficulty_error: '0',
    benchmark_difficulty: null,
  },
  {
    uuid: 'FD862B8147CD4473AD8145B36C32702C',
    name: '+N手作（for kid) 橫渡小朋友',
    frames:
      'p1126r13p1128r13p1131r13p1136r13p1142r13p1144r13p1147r13p1150r13p1151r13p1156r13p1157r12,",",p1110r13p1115r13p1128r13p1130r13p1133r13p1134r13p1137r13p1139r13p1142r13p1147r13p1153r13p1157r14,","',
    framesCount: 6,
    layoutId: 1,
    boardType: 'kilter',
    angle: 40,
    setter_username: 'Story climber',
    ascensionist_count: 243,
    difficulty: '6b/V4',
    quality_average: '4.5',
    stars: 4,
    difficulty_error: '0',
    benchmark_difficulty: null,
  },
  {
    uuid: '9E55C65719C2453F94508D7F7567E403',
    name: 'No. 15',
    frames:
      'p1143r12p1175r12p1198r13p1202r13p1212r13p1215r13,"p1239r13p1256r13p1270r13p1310r13,"x1143x1175x1198x1212p1341r13p1356r13,"p1331r13p1336r13p1349r13p1369r13,"p1311r14',
    framesCount: 5,
    layoutId: 1,
    boardType: 'kilter',
    angle: 40,
    setter_username: 'Story climber',
    ascensionist_count: 284,
    difficulty: '6b/V4',
    quality_average: '4.5',
    stars: 4,
    difficulty_error: '0',
    benchmark_difficulty: null,
  },
];

// A static first-frame projection keeps thumbnails and player captures stable;
// the full authentic sequences remain available for animation stories above.
export const STORY_CLIMBS: Climb[] = STORY_ANIMATED_CLIMBS.map((climb) => ({
  ...climb,
  frames: climb.frames.split(',')[0],
  framesCount: 1,
}));
