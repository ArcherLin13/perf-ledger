__kernel void chain_k4_2560(const int width) {
  const int x = get_global_id(0);
  const int y = get_global_id(1);
  float v = (float)(x + y);
}
