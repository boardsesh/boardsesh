#version 310 es
precision highp float;
void main() {
    vec2 points[3] = vec2[3](vec2(-1.0,-1.0),vec2(3.0,-1.0),vec2(-1.0,3.0));
    gl_Position=vec4(points[gl_VertexID],0.0,1.0);
}