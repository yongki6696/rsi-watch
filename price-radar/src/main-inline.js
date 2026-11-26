// 화면 파일을 Worker 안에 함께 묶어 배포할 때의 진입점 (wrangler.cli.jsonc 에서 사용)
import worker from './index.js';
import { FILES } from './assets.gen.js';
import { makeAssetsFetcher } from './static-assets.js';

const ASSETS = makeAssetsFetcher(FILES);

export default {
  fetch(request, env, ctx) {
    return worker.fetch(request, env.ASSETS ? env : { ...env, ASSETS }, ctx);
  },
  scheduled(event, env, ctx) {
    return worker.scheduled(event, env, ctx);
  },
};
