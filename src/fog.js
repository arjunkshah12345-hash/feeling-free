import * as THREE from 'three';

// Height-aware exponential haze: thick near the meadow, thinner up the spires,
// so the far city stays bright while its base melts into blue.
export function installFog() {
  THREE.ShaderChunk.fog_pars_vertex = `#ifdef USE_FOG
  varying float vFogDepth;
  varying float vFogH;
#endif`;
  THREE.ShaderChunk.fog_vertex = `#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vec4 fogWP = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    fogWP = instanceMatrix * fogWP;
  #endif
  fogWP = modelMatrix * fogWP;
  vFogH = fogWP.y;
#endif`;
  THREE.ShaderChunk.fog_pars_fragment = `#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying float vFogH;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;
  THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
  float fogHF = exp( - max( vFogH, 0.0 ) * 0.0021 );
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * max( vFogDepth - 420.0, 0.0 ) * mix( 0.4, 1.0, fogHF ) );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  fogFactor = min( fogFactor, 0.85 );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`;
}
