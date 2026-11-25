__kernel void chain_k2b_1920(const int width) {
  const int x = get_global_id(0);
  const int y = get_global_id(1);
  float v = (float)(x + y);
}
